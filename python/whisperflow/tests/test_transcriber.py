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
        self.writes: list[dict] = []
        self.targets_seen: list[object] = []
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

    def _write_outputs(self, result, input_path, *, targets=None):
        self.calls.append("write")
        self.written = copy.deepcopy(result)
        self.writes.append(copy.deepcopy(result))
        self.targets_seen.append(targets)
        if targets is not None:
            return targets
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
    # Pinned rather than inherited: these tests are about the shape of
    # run(), so each one says which stages it wants.  Both ship on as of
    # v1.17.3, which would otherwise silently change what they exercise.
    settings = {"diarize": False, "subtitle_segmentation": False, **overrides}
    cfg = TranscribeConfig(
        input_path=str(media),
        models_dir=str(tmp_path / "models"),
        **settings,
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

    assert stub.calls == ["vad", "write", "diarize", "segment", "write"]
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

    # One write, not two: the landing already happened, and cancelling
    # during diarization skipped the final one.  So a cancelled run still
    # leaves a usable transcript -- the Whisper pass was already paid for.
    assert stub.calls == ["vad", "write", "diarize"]
    assert len(stub.writes) == 1


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

    # No annotation stage, so nothing would have come between a landing
    # write and the real one: there is nothing to protect and only one write.
    assert stub.calls == ["vad", "write"]
    assert stub.written is not None
    assert "speaker" not in stub.written["segments"][0]
    assert "segmentation" not in stub.written


def test_a_successful_run_logs_no_warning(tmp_path, caplog):
    stub, _emitter = _make(tmp_path, diarize=True, subtitle_segmentation=True)

    with caplog.at_level(logging.WARNING, logger="whisperflow.transcriber"):
        stub.run()

    assert [r for r in caplog.records if r.levelno == logging.WARNING] == []


# --- landing the transcript before the annotation stages ---------------


def test_the_transcript_lands_before_the_annotation_stages(tmp_path):
    """The whole point of the landing: it happens while there is still
    something to lose, not after the stages it protects against."""
    stub, _emitter = _make(tmp_path, diarize=True, subtitle_segmentation=True)

    stub.run()

    assert stub.calls == ["vad", "write", "diarize", "segment", "write"]
    assert stub.calls.index("write") < stub.calls.index("diarize")


def test_the_landed_transcript_is_the_un_annotated_one(tmp_path):
    """It is a complete transcript, just without the annotations that had
    not run yet -- exactly what the user gets with the features off."""
    stub, _emitter = _make(tmp_path, diarize=True, subtitle_segmentation=True)

    stub.run()

    landed, final = stub.writes
    assert landed["text"] == "hello there"
    assert all("speaker" not in s for s in landed["segments"])
    assert "segmentation" not in landed
    # ... and the final write is the annotated one.
    assert final["segments"][0]["speaker"] == 0
    assert final["segmentation"] == {"version": 1}


def test_the_final_write_replays_the_landed_paths(tmp_path):
    """Resolving paths twice is what breaks the non-default policies."""
    stub, _emitter = _make(tmp_path, diarize=True)

    stub.run()

    landing_targets, final_targets = stub.targets_seen
    assert landing_targets is None            # the landing resolves
    assert final_targets is not None          # the final write replays


def test_nothing_lands_early_when_no_annotation_runs(tmp_path, caplog):
    stub, _emitter = _make(tmp_path)

    with caplog.at_level(logging.INFO, logger="whisperflow.transcriber"):
        stub.run()

    assert len(stub.writes) == 1
    assert "landed the transcript" not in caplog.text


# --- the overwrite_policy trap, against the real _write_outputs --------
#
# _Stub replaces _write_outputs, so these drive the real one directly.
# Without `pick` they are the tests that fail.


def _real(tmp_path: Path, **overrides) -> tuple[Transcriber, Path]:
    media = tmp_path / "talk.mkv"
    media.write_bytes(b"not really a video")
    cfg = TranscribeConfig(
        input_path=str(media),
        models_dir=str(tmp_path / "models"),
        output_dir=str(tmp_path / "out"),
        write_srt=True,
        write_vtt=False,
        write_txt=False,
        write_json=False,
        **overrides,
    )
    return Transcriber(cfg, emitter=_RecordingEmitter()), media


def _result(text: str) -> dict:
    return {
        "segments": [{"start": 0.0, "end": 1.0, "text": text, "words": []}],
        "text": text,
        "language": "en",
    }


@pytest.mark.parametrize("policy", ["overwrite", "skip", "rename-suffix"])
def test_the_annotated_rewrite_always_reaches_the_landed_file(tmp_path, policy):
    """Under "skip" a re-resolved path would make the final write look
    redundant against the landing's own file, and the user would keep the
    un-annotated copy forever -- the durability measure destroying the
    thing it exists to protect.  Under "rename-suffix" the annotated copy
    would land under a name nobody is looking for."""
    transcriber, media = _real(tmp_path, overwrite_policy=policy)

    landed = transcriber._write_outputs(_result("before"), media)
    final = transcriber._write_outputs(_result("after"), media, targets=landed)

    assert final.srt_path == landed.srt_path
    assert landed.srt_path is not None
    assert "after" in landed.srt_path.read_text(encoding="utf-8")
    # Exactly one subtitle file for one run, whatever the policy.
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["talk.srt"]


def test_the_policy_still_applies_to_a_file_that_was_already_there(tmp_path):
    """Asking once per run is not the same as never asking: a pre-existing
    file from an earlier run must still be honoured."""
    transcriber, media = _real(tmp_path, overwrite_policy="skip")
    stale = tmp_path / "out"
    stale.mkdir(parents=True)
    (stale / "talk.srt").write_text("from an earlier run", encoding="utf-8")

    landed = transcriber._write_outputs(_result("before"), media)
    transcriber._write_outputs(_result("after"), media, targets=landed)

    assert landed.srt_path is None
    assert (stale / "talk.srt").read_text(encoding="utf-8") == "from an earlier run"


# --- the two durability measures, together -----------------------------


class _DeadPipe:
    """stdout after the parent app has gone away."""

    def write(self, _text):
        raise BrokenPipeError(32, "Broken pipe")

    def flush(self):
        raise BrokenPipeError(32, "Broken pipe")


def test_an_orphaned_run_still_writes_its_subtitles(tmp_path, monkeypatch):
    """The failure this pair exists for, end to end.

    The app is closed mid-run; the spawned Python child is not killed and
    keeps going, but every progress tick now writes to a pipe with no
    reader.  The run must finish and the files must reach disk.
    """
    monkeypatch.setattr("sys.stdout", _DeadPipe())
    media = tmp_path / "talk.mkv"
    media.write_bytes(b"not really a video")
    cfg = TranscribeConfig(
        input_path=str(media),
        models_dir=str(tmp_path / "models"),
        diarize=True,
        subtitle_segmentation=False,
    )
    # A real EventEmitter, so the real guard runs -- _RecordingEmitter
    # overrides emit() and would never reach the write.
    stub = _Stub(cfg, EventEmitter(file_path=str(media), file_name=media.name))

    outputs = stub.run()

    assert stub.calls == ["vad", "write", "diarize", "write"]
    assert outputs.srt_path is not None


# --- the console note after re-segmentation ----------------------------


class _SegStub(_Stub):
    """Runs the real _run_segmentation so its logging is exercised."""

    def _run_segmentation(self, result):
        self.calls.append("segment")
        return Transcriber._run_segmentation(self, result)


def _worded(tmp_path, **overrides):
    stub, emitter = _make(tmp_path, subtitle_segmentation=True, **overrides)
    seg = _SegStub(stub._config, emitter)
    # One long segment with word timings, which is what re-segmentation needs.
    words = [
        {"start": i * 0.5, "end": i * 0.5 + 0.5, "word": f" word{i}"}
        for i in range(40)
    ]
    seg.result = {
        "segments": [{"start": 0.0, "end": 20.0,
                      "text": "".join(w["word"] for w in words).strip(),
                      "words": words}],
        "text": "x", "language": "en",
    }
    return seg


def test_the_console_says_the_raw_lines_above_were_not_the_subtitles(tmp_path, caplog):
    # bridge/run_cli.py forces verbose on, so the app's console has been
    # scrolling Whisper's raw segments the whole run -- with chunk-relative
    # timestamps that restart at 00:00:00 and lengths re-segmentation is
    # about to cut down.  A reader has every reason to take those for the
    # subtitles and report a cue that no longer exists by the time the
    # files are written.
    stub = _worded(tmp_path, verbose=True)

    with caplog.at_level(logging.INFO, logger="whisperflow.transcriber"):
        stub.run()

    note = [r.getMessage() for r in caplog.records if "raw segments" in r.getMessage()]
    assert len(note) == 1
    assert "not the subtitles" in note[0]
    # It has to carry the real count, or it is just reassurance.
    assert str(len(stub.written["segments"])) in note[0]


def test_the_note_is_absent_when_the_raw_lines_were_not_printed(tmp_path, caplog):
    # Nothing scrolled past, so there is nothing to correct.
    stub = _worded(tmp_path, verbose=False)

    with caplog.at_level(logging.INFO, logger="whisperflow.transcriber"):
        stub.run()

    assert not [r for r in caplog.records if "raw segments" in r.getMessage()]
