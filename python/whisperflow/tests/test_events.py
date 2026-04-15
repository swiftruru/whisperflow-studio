"""Unit tests for events.py — verifies the JSON line format Electron expects."""

from __future__ import annotations

import io
import json

from whisperflow.events import EVENT_PREFIX, EventEmitter, emitter_for


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
    em = emitter_for("/a/b/movie.mp4")
    assert em.file_name == "movie.mp4"
    assert em.file_path == "/a/b/movie.mp4"


def test_emitter_for_empty_returns_blank_emitter():
    em = emitter_for(None)
    assert em.file_name == ""
    assert em.file_path == ""
