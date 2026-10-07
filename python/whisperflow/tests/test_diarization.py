"""Unit tests for diarization.py (pure functions; sherpa-onnx not required)."""

from __future__ import annotations

import copy

import pytest

from whisperflow.diarization import (
    DEFAULT_SPEAKER_LABEL_TEMPLATE,
    ProgressThrottle,
    SpeakerTurn,
    assign_speakers,
    default_num_threads,
    renumber_turns,
    resolve_label_template,
    speaker_label,
    to_sherpa_num_clusters,
)


def _w(start: float, end: float, word: str) -> dict:
    """One word, shaped exactly as FasterWhisperCallback.invoke() emits it."""
    return {"start": start, "end": end, "word": word, "probability": 1.0}


def _seg(start: float, end: float, text: str, words: list | None = None) -> dict:
    segment = {"start": start, "end": end, "text": text}
    if words is not None:
        segment["words"] = words
    return segment


def _turn(start: float, end: float, speaker: int) -> SpeakerTurn:
    return SpeakerTurn(start, end, speaker)


class _RawSegment:
    """Stand-in for a sherpa-onnx result segment (.start/.end/.speaker)."""

    def __init__(self, start: float, end: float, speaker: int) -> None:
        self.start = start
        self.end = end
        self.speaker = speaker


# --- assign_speakers: the no-words path ----------------------------------


def test_assign_speakers_with_empty_turns_returns_input_unchanged():
    segments = [_seg(0.0, 1.0, "hello")]
    out = assign_speakers(segments, [])
    assert out is segments
    assert "speaker" not in out[0]


def test_assign_speakers_without_words_uses_segment_overlap():
    segments = [_seg(0.0, 2.0, "hello"), _seg(2.0, 4.0, "world")]
    turns = [_turn(0.0, 1.9, 0), _turn(1.9, 4.0, 1)]
    out = assign_speakers(segments, turns)
    assert [segment["speaker"] for segment in out] == [0, 1]
    # No words in, no words out -- and the segment is never split.
    assert "words" not in out[0]
    assert len(out) == 2


def test_assign_speakers_three_way_rotation_without_words():
    segments = [_seg(0.0, 1.0, "a"), _seg(1.0, 2.0, "b"), _seg(2.0, 3.0, "c"), _seg(3.0, 4.0, "d")]
    turns = [_turn(0.0, 1.0, 0), _turn(1.0, 2.0, 1), _turn(2.0, 3.0, 2), _turn(3.0, 4.0, 0)]
    out = assign_speakers(segments, turns)
    assert [segment["speaker"] for segment in out] == [0, 1, 2, 0]


def test_assign_speakers_handles_unsorted_turns():
    # _speaker_for_span stops scanning at the first turn starting after the
    # span, which is only sound when turns are sorted by start time.
    # Unsorted input used to produce a silently wrong answer: the scan broke
    # on the 20 s turn and never saw the 9.5 s overlap that should win.
    segments = [_seg(0.0, 10.0, "long")]
    turns = [_turn(0.0, 1.0, 0), _turn(20.0, 21.0, 3), _turn(0.5, 10.0, 1)]
    assert assign_speakers(segments, turns)[0]["speaker"] == 1


def test_assign_speakers_word_without_overlap_uses_nearest_turn():
    # The word falls inside a pause no turn covers, so the nearest one wins.
    words = [_w(1.0, 1.2, " hm")]
    turns = [_turn(0.0, 0.9, 0), _turn(3.0, 4.0, 1)]
    out = assign_speakers([_seg(1.0, 1.2, " hm", words)], turns)
    assert out[0]["speaker"] == 0


# --- assign_speakers: the word-level path --------------------------------


def test_assign_speakers_single_speaker_does_not_split():
    words = [_w(0.0, 0.5, " one"), _w(0.5, 1.0, " two"), _w(1.0, 1.5, " three")]
    out = assign_speakers([_seg(0.0, 1.5, " one two three", words)], [_turn(0.0, 2.0, 0)])
    assert len(out) == 1
    assert out[0]["speaker"] == 0
    assert out[0]["start"] == 0.0
    assert out[0]["end"] == 1.5
    assert out[0]["text"] == " one two three"


def test_assign_speakers_clean_handover_splits_into_two():
    words = [_w(0.0, 0.5, " aa"), _w(0.5, 1.0, " bb"), _w(2.0, 2.5, " cc"), _w(2.5, 3.0, " dd")]
    turns = [_turn(0.0, 1.2, 0), _turn(1.8, 3.5, 1)]
    out = assign_speakers([_seg(0.0, 3.2, " aa bb cc dd", words)], turns)

    assert [piece["speaker"] for piece in out] == [0, 1]
    assert [piece["text"] for piece in out] == [" aa bb", " cc dd"]
    # The outer boundaries stay where Whisper put them; only the interior
    # boundary comes from word timings.
    assert out[0]["start"] == 0.0
    assert out[0]["end"] == 1.0
    assert out[1]["start"] == 2.0
    assert out[1]["end"] == 3.2


def test_split_piece_text_is_word_concatenation_for_cjk():
    words = [_w(0.0, 0.3, "你"), _w(0.3, 0.6, "好"), _w(2.0, 2.3, "世"), _w(2.3, 2.6, "界")]
    turns = [_turn(0.0, 1.0, 0), _turn(1.5, 3.0, 1)]
    out = assign_speakers([_seg(0.0, 2.6, "你好世界", words)], turns)
    # Straight concatenation -- no separator invented for a language that
    # does not use one.
    assert [piece["text"] for piece in out] == ["你好", "世界"]


def test_assign_speakers_absorbs_boundary_jitter_word():
    # The middle word overlaps a 0.13 s sliver of speaker 1 and so would be
    # assigned to it, with speaker 0 on both sides.  That is jitter at a
    # turn boundary, not a hand-over.
    words = [_w(0.0, 0.5, " aa"), _w(0.5, 0.7, " bb"), _w(0.7, 1.2, " cc")]
    turns = [_turn(0.0, 0.55, 0), _turn(0.55, 0.68, 1), _turn(0.68, 3.0, 0)]
    out = assign_speakers([_seg(0.0, 1.2, " aa bb cc", words)], turns)

    assert len(out) == 1, "a jittered word must not split the segment"
    assert [word["speaker"] for word in out[0]["words"]] == [0, 0, 0]
    assert out[0]["text"] == " aa bb cc"


def test_assign_speakers_keeps_single_word_between_two_speakers():
    # A one-word run flanked by two *different* speakers is a real
    # hand-over and has to survive smoothing.
    words = [
        _w(0.0, 0.5, " a"),
        _w(0.5, 1.0, " b"),
        _w(1.0, 1.5, " c"),
        _w(1.5, 2.0, " d"),
        _w(2.0, 2.5, " e"),
    ]
    turns = [_turn(0.0, 1.0, 0), _turn(1.0, 1.5, 1), _turn(1.5, 2.5, 2)]
    out = assign_speakers([_seg(0.0, 2.5, " a b c d e", words)], turns)
    assert [piece["speaker"] for piece in out] == [0, 1, 2]
    assert [piece["text"] for piece in out] == [" a b", " c", " d e"]


def test_assign_speakers_leaves_edge_runs_alone():
    # Absorbing a short run at a segment edge has no "both sides agree"
    # signal to go on, and doing it anyway inverts short segments: with
    # three one-word runs, [0, 1, 0] would come out as [1, 0, 1].
    words = [_w(0.0, 0.5, " a"), _w(0.5, 1.0, " b"), _w(1.0, 1.5, " c"), _w(1.5, 2.0, " d")]
    turns = [_turn(0.0, 0.5, 1), _turn(0.5, 2.0, 0)]
    out = assign_speakers([_seg(0.0, 2.0, " a b c d", words)], turns)
    assert [piece["speaker"] for piece in out] == [1, 0]
    assert [piece["text"] for piece in out] == [" a", " b c d"]


def test_assign_speakers_without_split_keeps_one_segment():
    words = [_w(0.0, 0.5, " aa"), _w(0.5, 1.0, " bb"), _w(2.0, 2.9, " cc")]
    turns = [_turn(0.0, 1.2, 0), _turn(1.8, 3.5, 1)]
    out = assign_speakers(
        [_seg(0.0, 3.0, " aa bb cc", words)], turns, split_on_change=False
    )
    assert len(out) == 1
    # Majority by wall-clock time: speaker 0 holds 1.0 s, speaker 1 holds 0.9 s.
    assert out[0]["speaker"] == 0
    assert out[0]["text"] == " aa bb cc", "text is untouched when not splitting"
    assert [word["speaker"] for word in out[0]["words"]] == [0, 0, 1]


def test_assign_speakers_does_not_mutate_input():
    # Callers keep using the original result dict, and vad.base's
    # adjust_timestamps() already mutates word dicts in place -- so this
    # function copying rather than mutating is load-bearing.
    words = [_w(0.0, 0.5, " aa"), _w(2.0, 2.5, " bb")]
    segments = [_seg(0.0, 2.5, " aa bb", words)]
    snapshot = copy.deepcopy(segments)
    assign_speakers(segments, [_turn(0.0, 1.0, 0), _turn(1.5, 3.0, 1)])
    assert segments == snapshot


# --- renumbering ---------------------------------------------------------


def test_renumber_turns_by_first_appearance():
    # sherpa-onnx hands back raw cluster ids, which are not contiguous:
    # four speakers really do come back as 0, 1, 2, 7.
    raw = [
        _RawSegment(0.0, 1.0, 0),
        _RawSegment(1.0, 2.0, 1),
        _RawSegment(2.0, 3.0, 2),
        _RawSegment(3.0, 4.0, 7),
        _RawSegment(4.0, 5.0, 7),
        _RawSegment(5.0, 6.0, 1),
    ]
    turns = renumber_turns(raw)
    assert [turn.speaker for turn in turns] == [0, 1, 2, 3, 3, 1]
    assert turns[0] == SpeakerTurn(0.0, 1.0, 0)
    assert turns[-1] == SpeakerTurn(5.0, 6.0, 1)


def test_renumber_turns_handles_ids_that_do_not_start_at_zero():
    turns = renumber_turns([_RawSegment(0.0, 1.0, 5), _RawSegment(1.0, 2.0, 3)])
    assert [turn.speaker for turn in turns] == [0, 1]


# --- labels --------------------------------------------------------------


def test_speaker_label_is_one_based():
    assert speaker_label(0) == "Speaker 1"
    assert speaker_label(3) == "Speaker 4"
    assert speaker_label(0, "講者 {n}") == "講者 1"
    assert speaker_label(None) == ""


def test_label_template_falls_back_when_it_cannot_format():
    # A typo in the template costs the user the label they asked for, not
    # the whole transcription.
    for bad in ("Speaker {bogus}", "{0}", "{", "", "   ", None, 5):
        assert resolve_label_template(bad) == DEFAULT_SPEAKER_LABEL_TEMPLATE, bad
        assert speaker_label(0, bad) == "Speaker 1", bad


def test_label_template_keeps_anything_that_formats():
    for good in ("{n} 號", "S{n}", "[{n}]", "Speaker {n} ({n})"):
        assert resolve_label_template(good) == good, good


# --- knobs ---------------------------------------------------------------


def test_default_num_threads_is_bounded():
    assert 1 <= default_num_threads() <= 4


def test_zero_speakers_maps_to_automatic_clustering():
    # FastClusteringConfig(num_clusters=0) is a literal count of zero, not
    # "decide for me" -- and a blank Settings field coerces to 0.
    for raw in (0, "0", "", -1, None, "nonsense"):
        assert to_sherpa_num_clusters(raw) == -1, raw
    assert to_sherpa_num_clusters(4) == 4
    assert to_sherpa_num_clusters("4") == 4


# --- progress ------------------------------------------------------------


def test_progress_throttle_rate_limits_and_closes_the_band():
    emitted: list[float] = []
    now = [0.0]
    throttle = ProgressThrottle(emitted.append, start=60.0, span=30.0, clock=lambda: now[0])

    throttle(0.0)
    assert emitted == [60.0], "the first call always emits"

    now[0] += 0.05
    throttle(0.5)
    assert emitted == [60.0], "inside the 0.2 s window"

    now[0] += 0.2
    throttle(0.5)
    assert emitted == [60.0, 75.0]

    now[0] += 1.0
    throttle(0.501)
    assert emitted == [60.0, 75.0], "less than one percentage point of change"

    throttle(1.0)
    assert emitted == [60.0, 75.0, 90.0], "the final value always lands"


def test_progress_throttle_never_walks_backwards():
    emitted: list[float] = []
    now = [0.0]
    throttle = ProgressThrottle(emitted.append, start=60.0, span=30.0, clock=lambda: now[0])
    throttle(0.5)
    now[0] += 10.0
    throttle(0.1)
    assert emitted == [75.0]


def test_progress_throttle_clamps_out_of_range_fractions():
    emitted: list[float] = []
    throttle = ProgressThrottle(emitted.append, start=60.0, span=30.0, clock=lambda: 0.0)
    throttle(-1.0)
    assert emitted == [60.0]
    throttle(2.0)
    assert emitted == [60.0, 90.0]


# --- lazy dependency ----------------------------------------------------


def test_sherpa_onnx_is_imported_lazily():
    import whisperflow.diarization as module

    # A module-level ``import sherpa_onnx`` would make every test above an
    # ImportError on CI, which installs only pytest, ffmpeg-python, numpy.
    assert not hasattr(module, "sherpa_onnx")
    assert callable(module._import_sherpa_onnx)


def test_sherpa_onnx_exposes_the_api_we_rely_on():
    sherpa_onnx = pytest.importorskip("sherpa_onnx")
    # Pinned so a sherpa-onnx upgrade that renames any of these fails here
    # rather than mid-transcription.  Skipped on CI.
    for name in (
        "OfflineSpeakerDiarizationConfig",
        "OfflineSpeakerSegmentationModelConfig",
        "OfflineSpeakerSegmentationPyannoteModelConfig",
        "SpeakerEmbeddingExtractorConfig",
        "FastClusteringConfig",
        "OfflineSpeakerDiarization",
    ):
        assert hasattr(sherpa_onnx, name), name
