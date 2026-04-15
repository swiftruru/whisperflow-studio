# New module (no upstream counterpart).
# Emits the ``[WhisperFlowEvent] { ... }`` JSON lines that Electron's
# python-runner.js parses for progress/stage updates.  The payload shape is
# kept compatible with the previous bridge/run_cli.py output so the
# renderer-side event handlers don't need to change.

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

EVENT_PREFIX = "[WhisperFlowEvent]"


# Canonical stage names.  The renderer maps these to progress bar states,
# so any change here has to be mirrored in the UI.
STAGE_PREPARING = "preparing"
STAGE_LOADING_MODEL = "loading-model"
STAGE_TRANSCRIBING = "transcribing"
STAGE_WRITING_SUBTITLE = "writing-subtitle"
STAGE_COMPLETED = "completed"
STAGE_FAILED = "failed"


@dataclass
class EventEmitter:
    """Writes structured JSON events to ``sys.stdout`` for Electron to consume.

    One emitter per transcription job.  ``file_path`` / ``file_name`` are baked
    in so each ``emit()`` call only needs the variable parts (stage, message,
    progress).
    """

    file_path: str = ""
    file_name: str = ""
    source: str = "whisperflow"
    start_time: float = field(default_factory=time.monotonic)

    def emit(
        self,
        event_type: str,
        *,
        stage: str = "",
        message: str = "",
        message_key: str = "",
        message_params: Optional[dict[str, Any]] = None,
        progress: Optional[float] = None,
        eta_seconds: Optional[float] = None,
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        """Emit a structured event to Electron.

        ``message_key`` / ``message_params`` are the i18n contract:
        Electron's runner-event parser prefers them over the raw
        ``message`` field when present, and the renderer translates
        into the user's current language.  The plain ``message`` field
        is kept as a fallback (for environments where Electron hasn't
        loaded the event key yet, or for log-only surfaces that don't
        care about localization) and as the stable text that gets
        written into the Console transcript.
        """
        payload: dict[str, Any] = {
            "type": event_type,
            "stage": stage,
            "message": message,
            "messageKey": message_key,
            "messageParams": message_params or {},
            "progress": progress,
            "elapsedSeconds": int(max(0, time.monotonic() - self.start_time)),
            "etaSeconds": int(eta_seconds) if eta_seconds is not None else None,
            "filePath": self.file_path,
            "fileName": self.file_name,
            "timestamp": _utc_now_isoformat(),
            "source": self.source,
        }
        if extra:
            payload["meta"] = extra

        sys.stdout.write(f"{EVENT_PREFIX} {json.dumps(payload, ensure_ascii=False)}\n")
        sys.stdout.flush()

    # --- convenience helpers --------------------------------------------

    def stage(
        self,
        stage: str,
        message: str = "",
        progress: Optional[float] = None,
        *,
        message_key: str = "",
        message_params: Optional[dict[str, Any]] = None,
    ) -> None:
        self.emit(
            "stage",
            stage=stage,
            message=message,
            message_key=message_key,
            message_params=message_params,
            progress=progress,
        )

    def warning(self, message: str, *, stage: str = "", progress: Optional[float] = None) -> None:
        self.emit("warning", stage=stage, message=message, progress=progress)

    def error(self, message: str, *, stage: str = STAGE_FAILED, extra: Optional[dict[str, Any]] = None) -> None:
        self.emit("error", stage=stage, message=message, extra=extra)

    def completed(
        self,
        message: str = "Subtitle files generated",
        *,
        message_key: str = "events:stage.completed",
        message_params: Optional[dict[str, Any]] = None,
    ) -> None:
        self.emit(
            "completed",
            stage=STAGE_COMPLETED,
            message=message,
            message_key=message_key,
            message_params=message_params,
            progress=100,
        )


def _utc_now_isoformat() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def emitter_for(path: Optional[str]) -> EventEmitter:
    """Build an emitter with the file-path metadata pre-populated."""
    if not path:
        return EventEmitter()
    p = Path(path)
    return EventEmitter(file_path=str(p), file_name=p.name)
