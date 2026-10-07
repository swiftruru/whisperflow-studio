"""Unit tests for events.py — verifies the JSON line format Electron expects."""

from __future__ import annotations

import io
import json

from whisperflow.events import (
    EVENT_PREFIX,
    STAGE_COMPLETED,
    STAGE_DIARIZING,
    STAGE_FAILED,
    STAGE_LOADING_MODEL,
    STAGE_LOADING_VAD,
    STAGE_PREPARING,
    STAGE_TRANSCRIBING,
    STAGE_WRITING_SUBTITLE,
    EventEmitter,
    emitter_for,
)


def test_emit_writes_prefixed_json_line(capsys):
    emitter = EventEmitter(file_path="/tmp/foo.mp4", file_name="foo.mp4")
    emitter.stage("loading-model", "hi", progress=15)

    captured = capsys.readouterr()
    lines = [ln for ln in captured.out.splitlines() if ln.startswith(EVENT_PREFIX)]
    assert len(lines) == 1

    payload = json.loads(lines[0][len(EVENT_PREFIX) + 1 :])
    assert payload["type"] == "stage"
    assert payload["stage"] == "loading-model"
    assert payload["message"] == "hi"
    assert payload["progress"] == 15
    assert payload["filePath"] == "/tmp/foo.mp4"
    assert payload["fileName"] == "foo.mp4"
    assert payload["source"] == "whisperflow"
    assert payload["timestamp"].endswith("Z")


def test_emitter_for_pulls_name_from_path():
    # Use Path() on both sides so the assertion works on Windows too:
    # str(Path("/a/b/movie.mp4")) is "\\a\\b\\movie.mp4" there because
    # pathlib normalises to the native separator.
    from pathlib import Path

    test_path = "/a/b/movie.mp4"
    em = emitter_for(test_path)
    assert em.file_name == "movie.mp4"
    assert em.file_path == str(Path(test_path))


def test_emitter_for_empty_returns_blank_emitter():
    em = emitter_for(None)
    assert em.file_name == ""
    assert em.file_path == ""


def test_stage_constants_match_the_strings_the_ui_keys_on():
    # These exact strings are keyed on in five places outside Python:
    # locales/*/events.json, locales/*/progress.json, queue-panel.js's
    # stageLabel keyMap, queue-manager.js's getStageProgress, and
    # console-log.js's STAGE_LABELS.  A typo here shows up as a stage chip
    # silently reading "Idle", so pin them.
    assert STAGE_PREPARING == "preparing"
    assert STAGE_LOADING_MODEL == "loading-model"
    assert STAGE_LOADING_VAD == "loading-vad"
    assert STAGE_TRANSCRIBING == "transcribing"
    assert STAGE_DIARIZING == "diarizing"
    assert STAGE_WRITING_SUBTITLE == "writing-subtitle"
    assert STAGE_COMPLETED == "completed"
    assert STAGE_FAILED == "failed"
