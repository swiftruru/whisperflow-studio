"""Pipeline-level tests for Transcriber.run().

The subject here is _run_annotation: diarization and subtitle segmentation
annotate a transcript that Whisper has already finished producing, so a
failure in either must never cost the user that transcript.

_Stub subclasses Transcriber rather than reimplementing it, so the real
run() and the real _run_annotation execute; only the parts that need a
GPU, a model or a disk are replaced.  A stub that merely looked like a
Transcriber would let a guard regress without any test noticing.
"""

from __future__ import annotations

import copy
import logging
from pathlib import Path

import pytest

from whisperflow.config import TranscribeConfig
from whisperflow.events import EventEmitter
from whisperflow.transcriber import TranscribeOutputs, Transcriber


class _RecordingEmitter(EventEmitter):
    """Collects events instead of writing JSON to stdout."""

    def __init__(self) -> None:
        super().__init__()
        self.events: list[tuple[str, str]] = []

    def emit(self, event_type, *, stage="", **kwargs):  # noqa: D102
        self.events.append((event_type, stage))

    @property
    def stages(self) -> list[str]:
        return [stage for _type, stage in self.events]

    @property
    def types(self) -> list[str]:
        return [event_type for event_type, _stage in self.events]


class _Backend:
    def get_model(self):
        return object()

    def create_callback(self, **_kwargs):
        return object()


class _Stub(Transcriber):
    """Real pipeline, stubbed I/O."""

    def __init__(self, config: TranscribeConfig, emitter: EventEmitter) -> None:
        super().__init__(config, emitter=emitter)
        self.calls: list[str] = []
        self.diarization_error: BaseException | None = None
        self.segmentation_error: BaseException | None = None
        self.written: dict | None = None
        self.result: dict = {
            "segments": [
                {"start": 0.0, "end": 1.0, "text": "hello", "words": []},
                {"start": 1.0, "end": 2.0, "text": "there", "words": []},
            ],
            "text": "hello there",
            "language": "en",
        }

    # -- replaced: needs a model / a disk -------------------------------
    def _build_backend(self):
        return _Backend()

    def _build_prompt_strategy(self):
        return None

    def _build_decode_options(self):
        return {}

    def _run_vad(self, _path, _callback):
        self.calls.append("vad")
        return self.result

    def _write_outputs(self, result, input_path):
        self.calls.append("write")
        self.written = copy.deepcopy(result)
        return TranscribeOutputs(
            srt_path=Path(f"{input_path}.srt"),
            vtt_path=None,
            txt_path=None,
            json_path=None,
            result=result,
        )

    # -- replaced: the annotation stages under test ---------------------
    def _run_diarization(self, result, _input_path):
        self.calls.append("diarize")
        if self.diarization_error is not None:
            raise self.diarization_error
        for segment in result["segments"]:
            segment["speaker"] = 0
        result["segments"][0]["speaker_label"] = "Speaker 1"

    def _run_segmentation(self, result):
        self.calls.append("segment")
        if self.segmentation_error is not None:
            raise self.segmentation_error
        result["segmentation"] = {"version": 1}


def _make(tmp_path: Path, **overrides) -> tuple[_Stub, _RecordingEmitter]:
    media = tmp_path / "talk.mkv"
    media.write_bytes(b"not really a video")
    cfg = TranscribeConfig(
        input_path=str(media),
        models_dir=str(tmp_path / "models"),
        **overrides,
    )
    emitter = _RecordingEmitter()
    return _Stub(cfg, emitter), emitter


# --- the regression this module exists for -----------------------------


def test_a_failing_diarization_still_writes_the_subtitles(tmp_path):
    """The whole point: an hour of Whisper must survive a diarization crash."""
    stub, _emitter = _make(tmp_path, diarize=True)
    stub.diarization_error = RuntimeError("sherpa exploded")

    outputs = stub.run()

    assert "write" in stub.calls
    assert outputs.srt_path is not None


def test_a_failing_segmentation_still_writes_the_subtitles(tmp_path):
    stub, _emitter = _make(tmp_path, subtitle_segmentation=True)
    stub.segmentation_error = ValueError("bad cue")

    outputs = stub.run()

    assert "write" in stub.calls
    assert outputs.srt_path is not None


def test_a_failing_diarization_leaves_the_transcript_untouched(tmp_path):
    """The fallback output is the feature-off output, not a half-annotated one."""
    stub, _emitter = _make(tmp_path, diarize=True)
    stub.diarization_error = RuntimeError("sherpa exploded")

    stub.run()

    assert stub.written is not None
    for segment in stub.written["segments"]:
        assert "speaker" not in segment
        assert "speaker_label" not in segment
    assert stub.written["text"] == "hello there"


def test_a_failing_diarization_does_not_stop_segmentation(tmp_path):
    """The two stages fail independently; one dying must not skip the other."""
    stub, _emitter = _make(tmp_path, diarize=True, subtitle_segmentation=True)
    stub.diarization_error = RuntimeError("sherpa exploded")

    stub.run()

    assert stub.calls == ["vad", "diarize", "segment", "write"]
    assert stub.written is not None
    assert stub.written["segmentation"] == {"version": 1}


def test_a_failing_stage_still_completes_the_run(tmp_path):
    """A degraded run is a finished run: the queue must not show it as failed."""
    stub, emitter = _make(tmp_path, diarize=True)
    stub.diarization_error = RuntimeError("sherpa exploded")

    stub.run()

    assert "completed" in emitter.types
    assert "error" not in emitter.types


def test_the_failure_is_logged_as_a_warning_naming_the_stage(tmp_path, caplog):
    """Silent degradation would be worse than the crash it replaces."""
    stub, _emitter = _make(tmp_path, diarize=True)
    stub.diarization_error = RuntimeError("sherpa exploded")

    with caplog.at_level(logging.WARNING, logger="whisperflow.transcriber"):
        stub.run()

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "speaker diarization" in warnings[0].getMessage()
    # exc_info is what makes the cause diagnosable from a user's saved log.
    assert warnings[0].exc_info is not None
    assert "sherpa exploded" in caplog.text


def test_a_failing_segmentation_names_its_own_stage(tmp_path, caplog):
    stub, _emitter = _make(tmp_path, subtitle_segmentation=True)
    stub.segmentation_error = ValueError("bad cue")

    with caplog.at_level(logging.WARNING, logger="whisperflow.transcriber"):
        stub.run()

    assert "subtitle segmentation" in caplog.text


# --- the guard must not swallow too much -------------------------------


@pytest.mark.parametrize("cancellation", [KeyboardInterrupt, SystemExit])
def test_a_cancellation_is_not_swallowed(tmp_path, cancellation):
    """Catching BaseException would make the stop button stop nothing."""
    stub, _emitter = _make(tmp_path, diarize=True)
    stub.diarization_error = cancellation()

    with pytest.raises(cancellation):
        stub.run()

    assert "write" not in stub.calls


# --- the guard must not change the happy path --------------------------


def test_a_successful_diarization_still_annotates(tmp_path):
    stub, _emitter = _make(tmp_path, diarize=True)

    stub.run()

    assert stub.written is not None
    assert stub.written["segments"][0]["speaker"] == 0
    assert stub.written["segments"][0]["speaker_label"] == "Speaker 1"


def test_both_stages_are_skipped_when_switched_off(tmp_path):
    """The bytes-identical-when-off invariant: no annotation call at all."""
    stub, _emitter = _make(tmp_path)

    stub.run()

    assert stub.calls == ["vad", "write"]
    assert stub.written is not None
    assert "speaker" not in stub.written["segments"][0]
    assert "segmentation" not in stub.written


def test_a_successful_run_logs_no_warning(tmp_path, caplog):
    stub, _emitter = _make(tmp_path, diarize=True, subtitle_segmentation=True)

    with caplog.at_level(logging.WARNING, logger="whisperflow.transcriber"):
        stub.run()

    assert [r for r in caplog.records if r.levelno == logging.WARNING] == []
