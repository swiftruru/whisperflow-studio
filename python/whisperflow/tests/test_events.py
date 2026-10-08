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


# --- a dead stdout must not end the run --------------------------------
#
# Electron spawns this process and reads events off its stdout.  Closing
# or killing the app does not kill the child, so it keeps transcribing
# into a pipe with nobody on the other end.  An unguarded write aborts
# the run at the next progress tick, throwing away a Whisper pass that
# may be most of an hour old -- and the transcript still has to reach
# disk, which needs no reader.


class _DeadPipe(io.StringIO):
    """stdout whose far end has gone away."""

    def write(self, _text):
        raise BrokenPipeError(32, "Broken pipe")


class _ClosedStream(io.StringIO):
    def write(self, _text):
        raise ValueError("I/O operation on closed file")


def test_a_broken_pipe_does_not_end_the_run(monkeypatch):
    monkeypatch.setattr("sys.stdout", _DeadPipe())
    emitter = EventEmitter(file_path="/tmp/a.mkv", file_name="a.mkv")

    emitter.stage(STAGE_TRANSCRIBING, message="Running", progress=30)

    assert emitter._stdout_broken is True


def test_a_closed_stdout_does_not_end_the_run(monkeypatch):
    monkeypatch.setattr("sys.stdout", _ClosedStream())
    emitter = EventEmitter()

    emitter.stage(STAGE_TRANSCRIBING, message="Running", progress=30)

    assert emitter._stdout_broken is True


def test_every_later_event_is_also_survivable(monkeypatch):
    """The failure repeats on every tick, so surviving it once is not enough."""
    monkeypatch.setattr("sys.stdout", _DeadPipe())
    emitter = EventEmitter()

    for percent in range(30, 95, 5):
        emitter.stage(STAGE_TRANSCRIBING, message="Running", progress=percent)
    emitter.completed()

    assert emitter._stdout_broken is True


def test_a_healthy_stdout_is_untouched(monkeypatch):
    """The guard must not swallow anything on the normal path."""
    stream = io.StringIO()
    monkeypatch.setattr("sys.stdout", stream)
    emitter = EventEmitter(file_path="/tmp/a.mkv", file_name="a.mkv")

    emitter.stage(STAGE_TRANSCRIBING, message="Running", progress=30)

    line = stream.getvalue()
    assert line.startswith(EVENT_PREFIX)
    payload = json.loads(line[len(EVENT_PREFIX):])
    assert payload["stage"] == STAGE_TRANSCRIBING
    assert payload["progress"] == 30
    assert emitter._stdout_broken is False
