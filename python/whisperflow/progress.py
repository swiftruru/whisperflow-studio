# Rewritten from faster-whisper-webui src/hooks/ (Apache 2.0, (c) aadnk).
# Changes: dropped the thread-local tqdm monkey-patch that was specific to
# openai/whisper (faster-whisper reports progress natively via its segment
# generator, so no hook is needed).  Kept the two useful abstractions:
# a ProgressListener protocol and a sub-task listener that maps a child
# progress range into a parent listener.  See /NOTICES.md for details.

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class ProgressListener(Protocol):
    """Minimal protocol for consumers that want to observe transcription progress.

    Implementations should be thread-safe; the transcriber may call them from
    worker threads when parallel VAD is enabled.
    """

    def on_progress(self, current: float, total: float) -> None: ...

    def on_finished(self) -> None: ...


class NullProgressListener:
    """No-op listener.  Useful as a default when no progress tracking is needed."""

    def on_progress(self, current: float, total: float) -> None:
        return None

    def on_finished(self) -> None:
        return None


class SubTaskProgressListener:
    """Maps a child task's [0, child_total] progress into a slice of the parent.

    Example: a parent progress of 0..100 is made up of three sub-tasks of sizes
    20, 50, 30.  The second sub-task would be constructed as
    ``SubTaskProgressListener(parent, parent_total=100, sub_start=20, sub_total=50)``.
    """

    def __init__(
        self,
        parent: ProgressListener,
        *,
        parent_total: float,
        sub_start: float,
        sub_total: float,
    ) -> None:
        self._parent = parent
        self._parent_total = parent_total
        self._sub_start = sub_start
        self._sub_total = sub_total

    def on_progress(self, current: float, total: float) -> None:
        if total <= 0:
            return
        fraction = current / total
        mapped = self._sub_start + self._sub_total * fraction
        self._parent.on_progress(mapped, self._parent_total)

    def on_finished(self) -> None:
        self._parent.on_progress(self._sub_start + self._sub_total, self._parent_total)
