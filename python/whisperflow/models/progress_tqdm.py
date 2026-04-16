# New module (no upstream counterpart).
# Thin tqdm subclass that routes download progress into a callback
# instead of writing an ASCII bar to stderr.  Used by
# ModelManager._download_from_hub() to hook into
# huggingface_hub.snapshot_download()'s tqdm_class parameter.
#
# Why subclass real tqdm instead of a stub: huggingface_hub's
# thread_map uses multi-threaded blob downloads and calls
# ``tqdm_class.get_lock()`` on the class itself before instantiating,
# which means our class has to inherit tqdm's class-level lock
# infrastructure.  A plain stand-in class (or worse, a factory
# function) explodes with ``AttributeError: 'function' object has no
# attribute 'get_lock'`` the moment snapshot_download tries to
# download more than one file.  Subclassing ``tqdm.tqdm`` and
# overriding only ``update()`` / ``close()`` is the smallest change
# that makes the download loop happy.

from __future__ import annotations

import threading
from collections import deque
from time import monotonic
from typing import Any, Callable, Deque, Optional, Tuple

from tqdm import tqdm as _BaseTqdm

# Aggregate-view callback signature used by SharedProgressState's
# external observer: (cumulative_downloaded, job_total, speed, eta).
ProgressCallback = Callable[[int, int, float, float], None]

# Per-tqdm delta callback: receives just the byte delta reported by
# tqdm.update(n).  Each tqdm instance will call this with its own
# chunk size, and SharedProgressState sums them across the job.
DeltaCallback = Callable[[int], None]


# Shared lock protects cross-thread access from huggingface_hub's
# thread_map workers — they download blobs concurrently so their
# tqdm.update() calls race on the shared delta handler.
_shared_lock = threading.Lock()

# Class-level delta handler that every newly-created
# WhisperFlowProgressTqdm picks up.  Set via install_delta_handler()
# before calling snapshot_download(), and cleared afterwards.
_active_delta_handler: Optional[DeltaCallback] = None


def install_delta_handler(handler: Optional[DeltaCallback]) -> None:
    """Install the handler every new tqdm instance will call with its
    byte deltas.  Set to ``None`` to uninstall."""
    global _active_delta_handler
    with _shared_lock:
        _active_delta_handler = handler


def _get_delta_handler() -> DeltaCallback:
    with _shared_lock:
        handler = _active_delta_handler
    return handler or (lambda _n: None)


class WhisperFlowProgressTqdm(_BaseTqdm):
    """``tqdm.tqdm`` subclass that silently forwards updates to a callback.

    huggingface_hub calls ``tqdm_class(total=..., desc=..., unit=...,
    unit_scale=..., disable=...)`` for each blob being fetched and then
    invokes ``.update(n)`` with the number of bytes pulled in the last
    iteration.  We override ``__init__`` to force ``disable=True`` so
    no ASCII bar hits stderr, and we override ``update()`` to feed the
    same byte delta into our sliding-window speed / ETA accumulator.

    The sliding window matters because "bytes this chunk / time this
    chunk" would make the displayed speed flicker wildly near the end
    of a download (0 B/s burst burst 0 B/s).  A 10-second window
    smooths this out so the UI shows a stable figure the user can
    trust.

    **Note on multi-file downloads**: huggingface_hub instantiates a
    new tqdm per blob, so ``self.n`` only tracks *this file's* bytes.
    The ``SharedProgressState`` class below aggregates across every
    file into a single job-level total — connect it via
    :func:`set_active_callback` before calling
    :func:`huggingface_hub.snapshot_download`.
    """

    _WINDOW_SEC = 10.0
    _EMIT_EVERY_SEC = 0.2

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # Never write an ASCII bar; we only want the callback pipeline.
        kwargs["disable"] = True
        # huggingface_hub sometimes passes bar_format / leave / etc.
        # that real tqdm understands — just forward everything through.
        super().__init__(*args, **kwargs)
        self._samples: Deque[Tuple[float, int]] = deque()
        self._last_emit: float = 0.0
        # Capture the active callback at construction time so each
        # tqdm instance has a stable reference even if the outer
        # caller rotates callbacks mid-download.
        self._on_delta: DeltaCallback = _get_delta_handler()

    def update(self, n: int = 1) -> bool:
        ret = super().update(n)
        try:
            self._on_delta(int(n))
        except Exception:
            pass
        return ret

    def close(self) -> None:
        super().close()


class SharedProgressState:
    """Aggregates per-file tqdm deltas into a single job-level counter.

    huggingface_hub's ``snapshot_download`` runs multiple worker threads,
    each with its own ``WhisperFlowProgressTqdm`` instance.  Every
    instance calls our delta handler with the byte count of the chunk
    it just pulled.  This class sums those deltas into a running
    cumulative byte count and, on a throttled cadence, calls an
    external ``ProgressCallback`` with the aggregated
    ``(cumulative, job_total, speed, eta)`` tuple so the upstream
    observer (the EventEmitter on the CLI side) can emit a single
    unified progress line to stdout.

    Usage::

        shared = SharedProgressState(job_total_bytes=2_820_000_000)
        shared.set_external_callback(
            lambda d, t, s, e: emitter.emit("progress", ...)
        )
        install_delta_handler(shared.on_delta)
        try:
            snapshot_download(..., tqdm_class=WhisperFlowProgressTqdm)
        finally:
            install_delta_handler(None)
            shared.flush()
    """

    _WINDOW_SEC = 10.0
    _EMIT_EVERY_SEC = 0.2

    def __init__(self, job_total_bytes: int) -> None:
        self.job_total_bytes: int = int(job_total_bytes)
        self._lock = threading.Lock()
        self._cumulative: int = 0
        self._samples: Deque[Tuple[float, int]] = deque()
        self._external: Optional[ProgressCallback] = None
        self._last_emit: float = 0.0

    def set_external_callback(self, cb: Optional[ProgressCallback]) -> None:
        self._external = cb

    def on_delta(self, delta: int) -> None:
        """Called by every ``WhisperFlowProgressTqdm.update(n)`` across
        all worker threads."""
        with self._lock:
            self._cumulative += delta
            now = monotonic()
            self._samples.append((now, self._cumulative))
            while self._samples and now - self._samples[0][0] > self._WINDOW_SEC:
                self._samples.popleft()
            if now - self._last_emit < self._EMIT_EVERY_SEC:
                return
            self._last_emit = now
            speed = self._compute_speed()
            total = self.job_total_bytes or self._cumulative
            eta = (total - self._cumulative) / speed if speed > 0 and total > self._cumulative else 0.0
            cumulative = self._cumulative
        # Release lock before calling external to avoid deadlock if
        # the observer does something slow like I/O.
        if self._external is not None:
            try:
                self._external(cumulative, total, speed, eta)
            except Exception:
                pass

    def flush(self) -> None:
        """Force a final emission at the current cumulative value."""
        if self._external is None:
            return
        with self._lock:
            speed = self._compute_speed()
            total = self.job_total_bytes or self._cumulative
            cumulative = self._cumulative
        try:
            self._external(cumulative, total, speed, 0.0)
        except Exception:
            pass

    def _compute_speed(self) -> float:
        # Caller must hold ``self._lock``.
        if len(self._samples) < 2:
            return 0.0
        (t0, n0), (t1, n1) = self._samples[0], self._samples[-1]
        dt = t1 - t0
        if dt <= 0:
            return 0.0
        return (n1 - n0) / dt
