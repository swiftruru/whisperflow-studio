# Rewritten from faster-whisper-webui src/vadParallel.py (Apache 2.0, (c) aadnk).
# Changes: dataclass config, prints replaced by logger, clearer method names,
# ``_ProgressListenerToQueue`` renamed ``_QueueProgressListener``.  The
# multiprocessing/CUDA behaviour (spawn context, CUDA_VISIBLE_DEVICES) is
# preserved so NVIDIA multi-GPU setups still work on Linux/Windows.
# On macOS (no CUDA) the caller typically passes a single "device" and this
# module gracefully degrades to a one-process pool.
# See /NOTICES.md for license details.

from __future__ import annotations

import logging
import multiprocessing
import os
import threading
import time
from dataclasses import dataclass, field
from queue import Empty
from typing import Iterable, Optional

from ..models.whisper_container import TranscribeResult, WhisperCallback
from ..progress import ProgressListener
from .base import AbstractVadTranscription, TranscriptionConfig, get_audio_duration

_log = logging.getLogger(__name__)


class _QueueProgressListener:
    """Forwards incremental progress deltas across a multiprocessing Queue."""

    def __init__(self, queue: "multiprocessing.Queue") -> None:
        self._queue = queue
        self._total = 0.0
        self._previous = 0.0

    def on_progress(self, current: float, total: float) -> None:
        delta = current - self._previous
        self._previous = current
        self._total = total
        self._queue.put(delta)

    def on_finished(self) -> None:
        if self._total > self._previous:
            self._queue.put(self._total - self._previous)
            self._previous = self._total


class ParallelContext:
    """Reference-counted multiprocessing pool with optional idle cleanup.

    Consumers call :meth:`acquire_pool` to get a pool and :meth:`release_pool`
    when done.  If ``idle_timeout_seconds`` is set, the pool is torn down that
    many seconds after the last release (useful for long-running servers
    that want to free GPU memory between batches).
    """

    def __init__(
        self,
        *,
        num_processes: Optional[int] = None,
        idle_timeout_seconds: Optional[float] = None,
    ) -> None:
        self._num_processes = num_processes
        self._idle_timeout = idle_timeout_seconds
        self._lock = threading.Lock()
        self._ref_count = 0
        self._pool: Optional[multiprocessing.pool.Pool] = None
        self._cleanup_timer: Optional[threading.Timer] = None

    def acquire_pool(self) -> "multiprocessing.pool.Pool":
        with self._lock:
            if self._pool is None:
                context = multiprocessing.get_context("spawn")
                self._pool = context.Pool(self._num_processes)
            self._ref_count += 1
            self._cancel_cleanup()
            return self._pool

    def release_pool(self, pool: "multiprocessing.pool.Pool") -> None:
        with self._lock:
            if self._pool is not pool or self._ref_count <= 0:
                return
            self._ref_count -= 1
            if self._ref_count == 0 and self._idle_timeout is not None:
                self._schedule_cleanup()

    def close(self) -> None:
        with self._lock:
            self._cancel_cleanup()
            if self._pool is not None:
                _log.info("closing parallel pool (%s processes)", self._num_processes)
                self._pool.close()
                self._pool.join()
                self._pool = None

    def _schedule_cleanup(self) -> None:
        self._cancel_cleanup()
        self._cleanup_timer = threading.Timer(self._idle_timeout or 0, self._run_cleanup)
        self._cleanup_timer.start()
        _log.debug("scheduled pool cleanup in %ss", self._idle_timeout)

    def _cancel_cleanup(self) -> None:
        if self._cleanup_timer is not None:
            self._cleanup_timer.cancel()
            self._cleanup_timer = None

    def _run_cleanup(self) -> None:
        with self._lock:
            if self._ref_count == 0:
                if self._pool is not None:
                    self._pool.close()
                    self._pool.join()
                    self._pool = None


@dataclass
class ParallelTranscriptionConfig(TranscriptionConfig):
    """Per-device config passed into each worker process.

    ``override_timestamps`` lets the coordinator decide the speech segments
    centrally (on the parent process) and then hand each worker its own
    slice, so workers don't re-run VAD on the whole audio.
    """

    device_id: Optional[str] = None
    override_timestamps: Optional[list[dict]] = None

    @classmethod
    def from_base(
        cls,
        base: TranscriptionConfig,
        *,
        device_id: Optional[str],
        override_timestamps: Optional[list[dict]],
        initial_segment_index: int,
    ) -> "ParallelTranscriptionConfig":
        return cls(
            non_speech_strategy=base.non_speech_strategy,
            segment_padding_left=base.segment_padding_left,
            segment_padding_right=base.segment_padding_right,
            max_silent_period=base.max_silent_period,
            max_merge_size=base.max_merge_size,
            max_prompt_window=base.max_prompt_window,
            initial_segment_index=initial_segment_index,
            device_id=device_id,
            override_timestamps=override_timestamps,
        )


class ParallelVadTranscription(AbstractVadTranscription):
    """Coordinator that fans a transcription job out across multiple GPUs.

    The workflow is:
      1. Run the underlying VAD on the full audio (optionally parallelised
         across CPU cores if the VAD is slow enough to benefit).
      2. Split the resulting speech segments evenly across the GPU devices.
      3. For each GPU device, spawn a worker process, pin
         ``CUDA_VISIBLE_DEVICES``, and run Whisper on that device's slice.
      4. Merge the per-device results into a single transcript.
    """

    # Silero-VAD is fast enough that splitting audio below ~2 minutes per
    # chunk makes the overhead dominate the parallelism gains.
    MIN_CPU_CHUNK_SECONDS = 120.0

    def transcribe_parallel(
        self,
        *,
        vad: AbstractVadTranscription,
        audio_path: str,
        callback: WhisperCallback,
        config: TranscriptionConfig,
        gpu_devices: list[str],
        cpu_parallelism: int = 1,
        cpu_context: Optional[ParallelContext] = None,
        gpu_context: Optional[ParallelContext] = None,
        progress_listener: Optional[ProgressListener] = None,
    ) -> TranscribeResult:
        total_duration = get_audio_duration(audio_path)

        # 1) VAD pass (possibly parallelised across CPU cores).
        if cpu_parallelism > 1 and not vad.is_fast_vad():
            merged = self._vad_parallel_cpu(
                vad=vad,
                audio_path=audio_path,
                config=config,
                total_duration=total_duration,
                cpu_parallelism=cpu_parallelism,
                cpu_context=cpu_context,
            )
        else:
            raw = vad.get_speech_timestamps(audio_path, config, 0.0, total_duration)
            merged = vad.get_merged_timestamps(raw, config, total_duration)

        # 2) Pre-download weights in parent so workers don't race.
        if len(gpu_devices) > 1:
            container = getattr(callback, "_backend", None) or getattr(callback, "model_container", None)
            if container is not None and hasattr(container, "ensure_downloaded"):
                container.ensure_downloaded()

        # 3) Split segments across devices.
        per_device = list(_split_evenly(merged, len(gpu_devices)))
        manager = multiprocessing.Manager()
        progress_queue = manager.Queue()

        jobs = []
        segment_index = config.initial_segment_index
        for i, device_id in enumerate(gpu_devices):
            slice_ = per_device[i] if i < len(per_device) else []
            device_config = ParallelTranscriptionConfig.from_base(
                config,
                device_id=device_id,
                override_timestamps=slice_,
                initial_segment_index=segment_index,
            )
            segment_index += len(slice_)
            jobs.append((audio_path, callback, device_config, _QueueProgressListener(progress_queue)))

        merged_result: TranscribeResult = {"text": "", "segments": [], "language": None}

        owns_context = False
        if gpu_context is None:
            gpu_context = ParallelContext(num_processes=len(gpu_devices))
            owns_context = True

        pool = gpu_context.acquire_pool()
        perf_start = time.perf_counter()
        try:
            results_async = pool.starmap_async(self._run_one_device, jobs)
            total_progress = 0.0

            while not results_async.ready():
                try:
                    delta = progress_queue.get(timeout=5)
                except Empty:
                    continue
                total_progress += delta
                if progress_listener is not None:
                    progress_listener.on_progress(total_progress, total_duration)

            for result in results_async.get():
                if result.get("text"):
                    merged_result["text"] += result["text"]
                if result.get("segments"):
                    merged_result["segments"].extend(result["segments"])
                if result.get("language"):
                    merged_result["language"] = result["language"]

            if progress_listener is not None:
                progress_listener.on_finished()
        finally:
            gpu_context.release_pool(pool)
            if owns_context:
                gpu_context.close()

        _log.info("parallel transcription took %.2fs", time.perf_counter() - perf_start)
        return merged_result

    # --- worker entry point --------------------------------------------

    @staticmethod
    def _run_one_device(
        audio_path: str,
        callback: WhisperCallback,
        config: ParallelTranscriptionConfig,
        progress_listener: ProgressListener,
    ) -> TranscribeResult:
        """Runs inside a spawn()'d child process, one per GPU."""
        if os.environ.get("WHISPERFLOW_WORKER_INITIALIZED") is None:
            os.environ["WHISPERFLOW_WORKER_INITIALIZED"] = "1"
            if config.device_id is not None:
                _log.info("worker using CUDA device %s", config.device_id)
                os.environ["CUDA_VISIBLE_DEVICES"] = config.device_id

        # Inside the worker we go back through a plain transcription driver,
        # but with ``override_timestamps`` forcing it to use our pre-computed
        # segment slice instead of re-running VAD.
        driver = _OverrideVadTranscription(config.override_timestamps or [])
        return driver.transcribe(audio_path, callback, config, progress_listener=progress_listener)

    # --- parallel CPU VAD ----------------------------------------------

    def _vad_parallel_cpu(
        self,
        *,
        vad: AbstractVadTranscription,
        audio_path: str,
        config: TranscriptionConfig,
        total_duration: float,
        cpu_parallelism: int,
        cpu_context: Optional[ParallelContext],
    ) -> list[dict]:
        chunk_size = max(total_duration / cpu_parallelism, self.MIN_CPU_CHUNK_SECONDS)
        jobs = []
        cursor = 0.0
        while cursor < total_duration:
            chunk_end = min(cursor + chunk_size, total_duration)
            if chunk_end - cursor >= 1.0:
                jobs.append((audio_path, config, cursor, chunk_end))
            cursor = chunk_end

        owns_context = False
        if cpu_context is None:
            cpu_context = ParallelContext(num_processes=cpu_parallelism)
            owns_context = True

        pool = cpu_context.acquire_pool()
        perf_start = time.perf_counter()
        try:
            # We bind ``vad.get_speech_timestamps`` by sending ``vad`` as the
            # first positional arg.  It must be picklable (our silero/periodic
            # VADs both implement __getstate__).
            results = pool.starmap(_call_vad, [(vad, *args) for args in jobs])
            timestamps: list[dict] = []
            for chunk_result in results:
                timestamps.extend(chunk_result)
            merged = vad.get_merged_timestamps(timestamps, config, total_duration)
            _log.info("parallel CPU VAD took %.2fs", time.perf_counter() - perf_start)
            return merged
        finally:
            cpu_context.release_pool(pool)
            if owns_context:
                cpu_context.close()


class _OverrideVadTranscription(AbstractVadTranscription):
    """Stand-in VAD used inside worker processes: just returns the pre-computed slice."""

    def __init__(self, override: list[dict]) -> None:
        super().__init__()
        self._override = override

    def get_speech_timestamps(
        self,
        audio_path: str,
        config: TranscriptionConfig,
        start_time: float,
        end_time: float,
    ) -> list[dict]:
        return []

    def get_merged_timestamps(
        self,
        timestamps: list[dict],
        config: TranscriptionConfig,
        total_duration: float,
    ) -> list[dict]:
        return list(self._override)


def _call_vad(vad: AbstractVadTranscription, audio_path: str, config: TranscriptionConfig, start: float, end: float) -> list[dict]:
    """Module-level helper so it survives pickling across the CPU pool."""
    return vad.get_speech_timestamps(audio_path, config, start, end)


def _split_evenly(items: list, n: int) -> Iterable[list]:
    """Split ``items`` into ``n`` approximately equal lists."""
    if n <= 0:
        return
    k, m = divmod(len(items), n)
    for i in range(n):
        yield items[i * k + min(i, m) : (i + 1) * k + min(i + 1, m)]
