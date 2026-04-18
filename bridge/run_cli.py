#!/usr/bin/env python3
"""Bridge script Electron spawns to transcribe the currently queued file.

This used to be a ~250-line wrapper that subprocess'd an *external*
``faster-whisper-webui`` project.  Now it's a thin adapter that:

1. Loads ``python/config/config.json`` into a :class:`TranscribeConfig`.
2. Points ``input_path`` / ``output_dir`` at the queued media file.
3. Hands the whole thing to :func:`whisperflow.transcriber.Transcriber.run`.

All the heavy lifting and the ``[WhisperFlowEvent]`` progress stream come
from the in-process :mod:`whisperflow` package; nothing shells out.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

# ``python/`` lives next to ``bridge/`` in the source tree and inside the
# packaged app's resources directory.  Putting it on sys.path lets the
# bundled venv's site-packages find the whisperflow package.
SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_DIR = (SCRIPT_DIR / ".." / "python").resolve()
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from whisperflow.config import TranscribeConfig  # noqa: E402
from whisperflow.events import STAGE_FAILED, emitter_for  # noqa: E402
from whisperflow.transcriber import Transcriber  # noqa: E402


def _setup_logging() -> None:
    """Route the whisperflow package's ``_log.info(...)`` messages to
    ``sys.stdout`` so the Electron Console panel picks them up as plain
    log lines (not prefixed with ``[stderr]``).

    Without this the entire transcription pipeline runs silently from the
    user's perspective — Python's root logger has no handler installed,
    so every ``_log.info("loading model ...")`` / ``_log.info("silero VAD
    scanning ...")`` / per-segment line is dropped on the floor.

    stdout specifically (not stderr) because:

    1. python-runner.js on the Electron side parses stdout line-by-line
       and already filters out the machine-readable ``[WhisperFlowEvent]``
       JSON lines — non-event lines flow straight to the Console.
    2. stderr output gets a ``[stderr]`` prefix in the log, which is
       correct for real errors but wrong for informational logging.
    """
    root = logging.getLogger()
    already_configured = any(
        isinstance(h, logging.StreamHandler) and getattr(h, "stream", None) is sys.stdout
        for h in root.handlers
    )
    if already_configured:
        return
    handler = logging.StreamHandler(sys.stdout)
    # Keep the format minimal — the Console panel adds its own timestamp
    # column, and log-level labels would add noise to the transcript.
    handler.setFormatter(logging.Formatter("%(message)s"))
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def _build_config() -> TranscribeConfig:
    config_path = PYTHON_DIR / "config" / "config.json"
    config = TranscribeConfig.load(config_path)

    setting = _read_setting_section(config_path)
    media_dir = setting.get("media_file_path") or ""
    media_name = setting.get("media_file_name") or ""

    if media_dir and media_name:
        config.input_path = str(Path(media_dir) / media_name)
        config.output_dir = media_dir

    return config


def _read_setting_section(config_path: Path) -> dict:
    """Grab the raw SETTING dict so we can pull out media_file_* fields that
    the TranscribeConfig dataclass itself doesn't model."""
    import json

    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return raw.get("SETTING", {}) if isinstance(raw, dict) else {}


def main() -> int:
    _setup_logging()

    config = _build_config()

    # Force per-segment text output.  Without this the user stares at a
    # static Console for 2+ minutes while whisper runs; with it, each
    # decoded segment streams to the Console the moment it's produced,
    # giving clear live feedback ("[00:04:514 -> 00:06:514] 這邊是在日本成田機場").
    config.verbose = True

    if not config.input_path:
        emitter = emitter_for(None)
        emitter.error(
            "no media file queued (media_file_path/media_file_name are empty)",
            extra={"reason": "missing_media_file"},
        )
        return 2

    if not Path(config.input_path).is_file():
        emitter = emitter_for(config.input_path)
        emitter.error(
            f"queued file does not exist: {config.input_path}",
            extra={"reason": "missing_media_file"},
        )
        return 2

    emitter = emitter_for(config.input_path)
    try:
        transcriber = Transcriber(config, emitter=emitter)
        transcriber.run()
    except Exception as err:  # pragma: no cover - top-level safety net
        emitter.error(str(err), extra={"reason": type(err).__name__})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
