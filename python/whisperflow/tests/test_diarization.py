"""Unit tests for diarization.py (pure functions; sherpa-onnx not required)."""

from __future__ import annotations

import copy

import pytest

from whisperflow.diarization import (
    DEFAULT_SPEAKER_LABEL_TEMPLATE,
    MERGE_COSINE,
    MINOR_CLUSTER_SECONDS,
    ProgressThrottle,
    SherpaDiarizer,
    SpeakerTurn,
    assign_speakers,
    default_num_threads,
    label_speaker_turns,
    refine_labels,
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


# --- labelling a turn once ----------------------------------------------


def test_label_speaker_turns_labels_only_the_first_segment_of_a_turn():
    segments = [
        {"speaker": 0}, {"speaker": 0}, {"speaker": 1}, {"speaker": 1}, {"speaker": 0},
    ]
    written = label_speaker_turns(segments, "Speaker {n}")
    assert written == 3
    assert [segment.get("speaker_label") for segment in segments] == [
        "Speaker 1", None, "Speaker 2", None, "Speaker 1",
    ]


def test_label_speaker_turns_leaves_the_key_absent_in_between():
    # Absent rather than "": format_speaker_prefix and
    # transcript-reader.js both treat the two identically, so leaving it
    # out keeps the JSON smaller and the intent obvious.
    segments = [{"speaker": 0}, {"speaker": 0}]
    label_speaker_turns(segments)
    assert "speaker_label" in segments[0]
    assert "speaker_label" not in segments[1]


def test_label_speaker_turns_ignores_segments_with_no_speaker():
    segments = [{"text": "a"}, {"text": "b"}]
    assert label_speaker_turns(segments) == 0
    assert all("speaker_label" not in segment for segment in segments)


def test_label_speaker_turns_treats_speaker_zero_as_a_real_speaker():
    # 0 is falsy; a truthiness check here would drop every "Speaker 1".
    segments = [{"speaker": 0}]
    assert label_speaker_turns(segments) == 1
    assert segments[0]["speaker_label"] == "Speaker 1"


def test_label_speaker_turns_honours_the_template():
    segments = [{"speaker": 0}, {"speaker": 1}]
    label_speaker_turns(segments, "講者 {n}")
    assert [segment["speaker_label"] for segment in segments] == ["講者 1", "講者 2"]


# --- repairing over-clustering (refine_labels) ---------------------------
#
# These run on hand-built unit vectors, so they pin the ALGORITHM rather than
# the embedding model.  The constants themselves were calibrated on real
# audio; see the comment block above MERGE_COSINE.


def _unit(*values, dim: int = 4) -> list[float]:
    """A unit-length vector of width ``dim``, so cosines read off directly."""
    import math

    padded = list(values) + [0.0] * (dim - len(values))
    norm = math.sqrt(sum(v * v for v in padded)) or 1.0
    return [v / norm for v in padded]


def _basis(index: int, dim: int = 4) -> list[float]:
    return [1.0 if i == index else 0.0 for i in range(dim)]


def test_refine_labels_on_empty_input():
    assert refine_labels([], [], [], []) == []


def test_refine_labels_keeps_a_single_cluster():
    assert refine_labels([0], [_basis(0)], [True], [10.0]) == [0]


def test_refine_labels_leaves_distinct_speakers_alone():
    # Orthogonal centroids: cosine 0, far below MERGE_COSINE.
    labels = refine_labels(
        [0, 0, 1, 1],
        [_basis(0), _basis(0), _basis(1), _basis(1)],
        [True] * 4,
        [20.0, 20.0, 15.0, 15.0],
    )
    assert len(set(labels)) == 2
    # Renumbered by order of first appearance, so the cluster heard first is
    # speaker 0 regardless of who talks longer.
    assert labels == [0, 0, 1, 1]


def test_refine_labels_merges_one_speaker_split_in_two():
    # This is the real failure: two LARGE clusters that are the same person.
    # Neither is debris, so only the centroid comparison can catch it.
    near = _unit(1.0, 0.1)
    labels = refine_labels(
        [0, 0, 1, 1],
        [_basis(0), _basis(0), near, near],
        [True] * 4,
        [100.0, 100.0, 90.0, 90.0],
    )
    assert len(set(labels)) == 1, "0.995 cosine is one speaker, not two"


def test_refine_labels_absorbs_debris_into_the_nearest_centroid():
    # A 0.4 s singleton must not be a speaker.  It is closer to cluster 1.
    labels = refine_labels(
        [0, 0, 1, 1, 2],
        [_basis(0), _basis(0), _basis(1), _basis(1), _unit(0.0, 1.0, 0.2)],
        [True] * 5,
        [60.0, 60.0, 40.0, 40.0, 0.4],
    )
    assert len(set(labels)) == 2
    assert labels[4] == labels[2], "debris joins the speaker it resembles"


def test_refine_labels_never_drops_a_turn():
    # The failure this guards against: an empty turn list makes
    # assign_speakers leave every cue with no speaker at all.
    for durations in ([0.1] * 6, [0.4, 0.4, 0.4], [50.0, 0.2]):
        labels = refine_labels(
            list(range(len(durations))),
            [_basis(i % 4) for i in range(len(durations))],
            [True] * len(durations),
            durations,
        )
        assert len(labels) == len(durations)
        assert all(isinstance(value, int) for value in labels)


def test_refine_labels_when_every_cluster_is_below_the_floor():
    # Nothing is large enough to absorb INTO, so stage 1 must stand down
    # rather than collapse everything or return nothing.
    durations = [1.0, 1.0, 1.0]
    assert all(d < MINOR_CLUSTER_SECONDS for d in durations)
    labels = refine_labels(
        [0, 1, 2],
        [_basis(0), _basis(1), _basis(2)],
        [True] * 3,
        durations,
    )
    assert len(labels) == 3
    assert len(set(labels)) == 3, "orthogonal centroids must not be merged either"


def test_refine_labels_does_not_collapse_four_short_speakers():
    # Exactly the shape of sherpa's own 57 s four-speaker sample, which a
    # TURN-COUNT floor (pyannote's literal min_cluster_size=15) would fuse
    # into one speaker.  A seconds-of-speech floor is scale-free and must not.
    labels = refine_labels(
        [0, 1, 2, 3],
        [_basis(0), _basis(1), _basis(2), _basis(3)],
        [True] * 4,
        [11.3, 7.6, 5.9, 5.7],
    )
    assert len(set(labels)) == 4


def test_refine_labels_keeps_a_speaker_whose_every_fragment_is_sub_floor():
    # The stage-ORDER regression.  A questioner in a long talk speaks only in
    # short turns, and sherpa's complete linkage gives each its own cluster:
    # 2.62 / 1.08 / 0.83 s, every one below MINOR_CLUSTER_SECONDS, but 4.53 s
    # in total -- 1.5x the floor.  Applying the floor to the RAW clusters
    # erases them and reattributes every line to the dominant speaker, which
    # is worse than the over-counting this function exists to fix.  Merging
    # first puts the fragments back together, and then the floor is measured
    # against a speaker rather than against a symptom.
    quiet = [2.62, 1.08, 0.83]
    assert all(d < MINOR_CLUSTER_SECONDS for d in quiet)
    assert sum(quiet) > MINOR_CLUSTER_SECONDS

    labels = refine_labels(
        [0, 0, 1, 2, 3],
        [_basis(0), _basis(0), _basis(1), _basis(1), _basis(1)],
        [True] * 5,
        [100.0, 100.0] + quiet,
    )
    assert len(set(labels)) == 2, "the quiet speaker must survive as a speaker"
    assert labels[2] == labels[3] == labels[4], "their fragments are one person"
    assert labels[2] != labels[0], "and not the dominant speaker"


def test_refine_labels_is_idempotent_when_everything_is_sub_floor():
    # Differential fuzzing found this shape non-idempotent under an earlier
    # arrangement of the two stages.  Idempotence is NOT claimed in general
    # -- these two tests pin the shapes that were observed to break, not a
    # universal property.
    args = (
        [0, 0, 1, 3],
        [_basis(0), _basis(0), _unit(1.0, 0.05), _basis(2)],
        [True] * 4,
        [0.2, 0.2, 0.9, 2.9],
    )
    once = refine_labels(*args)
    twice = refine_labels(once, args[1], args[2], args[3])
    assert once == twice, "a second pass must not change a converged answer"

def test_refine_labels_renumbers_by_first_appearance():
    # The module has exactly one numbering convention -- SpeakerTurn and
    # renumber_turns both promise order of first appearance -- and refinement
    # must not invent a second one.  The ids here are chosen so that sorting
    # by raw id, by descending speech, and by first appearance all disagree.
    labels = refine_labels(
        [7, 7, 3],
        [_basis(0), _basis(0), _basis(1)],
        [True] * 3,
        [5.0, 5.0, 40.0],
    )
    assert labels == [0, 0, 1], (
        "the speaker heard first is Speaker 1, however little they say"
    )


def test_refine_labels_numbering_survives_a_merge():
    # After a merge the surviving label must still be the first-appearance
    # number of the EARLIEST turn in the merged group, not of whichever raw
    # cluster happened to win the merge.
    near = _unit(1.0, 0.05)
    labels = refine_labels(
        [5, 9, 5, 9],
        [_basis(0), near, _basis(0), near],
        [True] * 4,
        [2.0, 90.0, 2.0, 90.0],
    )
    assert len(set(labels)) == 1
    assert labels == [0, 0, 0, 0]


def test_refine_labels_unembeddable_turn_casts_no_vote_in_a_centroid():
    # A sub-0.7 s embedding is noise (measured cosine 0.18 to its own
    # speaker), so it must not drag its cluster's centroid.  Built so that
    # letting it vote would change the ANSWER: cluster 0 is orthogonal to
    # cluster 1, but the unusable row points straight at cluster 1 and is
    # weighted heavily enough to pull the centroid past MERGE_COSINE.
    labels = refine_labels(
        [0, 0, 1],
        [_basis(0), _basis(1), _basis(1)],
        [True, False, True],
        [10.0, 40.0, 30.0],
    )
    assert len(set(labels)) == 2, "the noise row must not fuse two speakers"
    assert len(labels) == 3
    assert labels[1] == labels[0], "but it still keeps the label it was given"


def test_refine_labels_absorbs_an_unembeddable_debris_turn_to_the_biggest():
    labels = refine_labels(
        [0, 0, 1],
        [_basis(0), _basis(0), [0.0, 0.0, 0.0, 0.0]],
        [True, True, False],
        [60.0, 60.0, 0.2],
    )
    assert len(set(labels)) == 1
    assert labels[2] == 0


def test_refine_labels_is_idempotent():
    # One observed shape, not a general guarantee -- see the note on
    # test_refine_labels_is_idempotent_when_everything_is_sub_floor.
    args = (
        [0, 0, 1, 1, 2],
        [_basis(0), _basis(0), _unit(1.0, 0.1), _unit(1.0, 0.1), _basis(2)],
        [True] * 5,
        [50.0, 50.0, 40.0, 40.0, 30.0],
    )
    once = refine_labels(*args)
    twice = refine_labels(once, args[1], args[2], args[3])
    assert once == twice


def test_refine_labels_merge_cosine_of_one_merges_nothing():
    labels = refine_labels(
        [0, 1],
        [_basis(0), _unit(1.0, 0.01)],
        [True] * 2,
        [40.0, 40.0],
        merge_cosine=1.0,
    )
    assert len(set(labels)) == 2


def test_refine_labels_merge_cosine_stays_inside_the_measured_window():
    # The window where BOTH calibration recordings give their known answer,
    # measured on the per-turn embeddings this module produces: the
    # 64-minute talk resolves to 4 speakers only for 0.59-0.64 (3 at 0.58,
    # 5 at 0.65), and sherpa's 57 s sample needs >= 0.50.  The earlier
    # version of this test allowed 0.50-0.65, which let 0.50 through -- and
    # 0.50 collapses the 64-minute talk to 2 speakers while this test passes.
    assert 0.59 <= MERGE_COSINE <= 0.64

# --- the refinement failure boundary -------------------------------------


class _Extractor:
    """Stand-in for sherpa's SpeakerEmbeddingExtractor."""

    def __init__(self, dim: int = 4, *, dim_raises: bool = False):
        self._dim = dim
        self._dim_raises = dim_raises

    @property
    def dim(self):
        if self._dim_raises:
            raise RuntimeError("ONNX Runtime session is gone")
        return self._dim


class _Stub(SherpaDiarizer):
    """A SherpaDiarizer with the sherpa parts replaced.

    It really SUBCLASSES SherpaDiarizer -- importable without sherpa-onnx,
    whose import is deferred into __init__ -- so `_refine` and
    `_refined_turns` under test are the production ones.  Only __init__ and
    `_embed_turn` are replaced; super().__init__ is deliberately not called,
    since that is the part that needs the real library.
    """

    def __init__(self, extractor, vector=None, embed_raises=False, per_turn=None,
                 num_speakers=0, refine=True, extractor_raises=False):
        # Seed the cache rather than the property: `_extractor` is read-only
        # and builds on first use, so this exercises the real accessor.
        self._extractor_cache = None if extractor_raises else extractor
        self._make_extractor = self._boom if extractor_raises else (lambda: extractor)
        self._num_speakers = num_speakers
        self._refine_enabled = refine
        self._vector = vector
        self._embed_raises = embed_raises
        self._per_turn = per_turn          # list of vector-or-None-or-Exception
        self._calls = 0

    @staticmethod
    def _boom():
        raise RuntimeError("ONNX Runtime refused to load the model")

    def _embed_turn(self, samples, turn):
        if self._embed_raises:
            raise RuntimeError("extractor exploded")
        if self._per_turn is not None:
            outcome = self._per_turn[self._calls]
            self._calls += 1
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        return self._vector


def _refine_with(stub, turns):
    return stub._refine([0.0] * 16000, turns)


def test_refine_survives_an_extractor_that_cannot_report_its_dimension(caplog):
    # The whole point of the boundary: by the time refinement runs the caller
    # holds a Whisper decode that cost minutes.  A label-polishing pass must
    # never take that down -- it hands back sherpa's own labels instead.
    turns = [_turn(0.0, 30.0, 0), _turn(31.0, 60.0, 1)]
    stub = _Stub(_Extractor(dim_raises=True))
    with caplog.at_level("WARNING"):
        out = _refine_with(stub, turns)
    assert out is turns, "unchanged means the very same list"
    assert "keeping sherpa's labels" in caplog.text


def test_refine_survives_an_extractor_that_throws_on_every_turn():
    # Every turn failing is not an error, it is just no evidence: the labels
    # come back exactly as sherpa produced them.
    turns = [_turn(0.0, 30.0, 0), _turn(31.0, 60.0, 1), _turn(61.0, 90.0, 2)]
    out = _refine_with(_Stub(_Extractor(), embed_raises=True), turns)
    assert [t.speaker for t in out] == [0, 1, 2]
    assert [(t.start, t.end) for t in out] == [(t.start, t.end) for t in turns]


def test_refine_leaves_a_single_turn_alone():
    turns = [_turn(0.0, 5.0, 0)]
    assert _refine_with(_Stub(_Extractor()), turns) is turns


def test_refine_tolerates_an_embedding_of_the_wrong_width(caplog):
    # A width mismatch between the extractor and what it returns raises
    # inside numpy; it must still degrade rather than propagate.
    turns = [_turn(0.0, 30.0, 0), _turn(31.0, 60.0, 1)]
    stub = _Stub(_Extractor(dim=4), vector=[1.0, 0.0])
    with caplog.at_level("WARNING"):
        out = _refine_with(stub, turns)
    assert [t.speaker for t in out] == [0, 1]
    assert len(out) == 2


def test_one_unusable_RETURN_value_does_not_abandon_the_repair():
    # The earlier version of this suite asserted the abandoned outcome here,
    # which pinned the bug in place: the per-turn guard wrapped only the
    # extractor CALL, so a turn that returned a wrong-width vector -- rather
    # than raising -- escaped to the outer boundary and threw away the whole
    # repair.  Turns 0 and 2 are plainly one speaker; only turn 1 misbehaves.
    same = _unit(1.0, 0.02)
    for bad in ([1.0, 0.0], "not a vector", [float("inf"), 0.0, 0.0, 0.0]):
        turns = [_turn(0.0, 40.0, 0), _turn(41.0, 50.0, 1), _turn(51.0, 90.0, 2)]
        stub = _Stub(_Extractor(dim=4), per_turn=[_basis(0), bad, same])
        out = _refine_with(stub, turns)
        speakers = [t.speaker for t in out]
        assert len(out) == 3, bad
        assert speakers[0] == speakers[2], f"the repair was abandoned for {bad!r}"
        assert len(set(speakers)) == 2, bad


def test_refine_skips_one_failing_turn_and_still_repairs_the_rest():
    # The inner guard earns its place here.  One turn's extractor call blows
    # up; the other two are plainly the same speaker.  With the per-turn
    # guard that pair still merges, so the repair survives a single bad turn.
    # Without it the outer boundary catches the throw and the whole repair is
    # abandoned -- which looks identical to "nothing to repair" in the logs.
    turns = [_turn(0.0, 40.0, 0), _turn(41.0, 50.0, 1), _turn(51.0, 90.0, 2)]
    same = _unit(1.0, 0.02)
    stub = _Stub(
        _Extractor(dim=4),
        per_turn=[_basis(0), RuntimeError("this one turn fails"), same],
    )
    out = _refine_with(stub, turns)
    assert len(out) == 3
    assert len({t.speaker for t in out}) == 2, (
        "turns 0 and 2 are one speaker; a single failing turn must not stop that"
    )
    assert out[0].speaker == out[2].speaker


def test_refine_labels_does_not_write_through_its_labels_argument():
    # np.asarray returns the SAME object for an int64 array, and both stages
    # write into it.  The docstring promises new labels, so a caller holding
    # its own must get them back intact.
    import numpy as np

    given = np.array([0, 0, 1, 1, 2], dtype=np.int64)
    before = given.copy()
    refine_labels(
        given,
        [_basis(0), _basis(0), _basis(1), _basis(1), _unit(0.0, 1.0, 0.2)],
        [True] * 5,
        [60.0, 60.0, 40.0, 40.0, 0.4],
    )
    assert np.array_equal(given, before), "the caller's labels were rewritten"


def test_refine_labels_rejects_a_non_finite_centroid():
    # An inf component makes the norm inf, inf/inf is NaN, and `NaN <
    # threshold` is False -- so an unguarded merge is taken unconditionally
    # and repeats until one cluster is left.  Three mutually ORTHOGONAL
    # speakers came back as one, reported as success.
    import numpy as np

    embeddings = np.array(
        [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [np.inf, 0.0, 0.0, 0.0]],
        dtype=np.float64,
    )
    labels = refine_labels([0, 1, 2], embeddings, [True] * 3, [40.0, 40.0, 40.0])
    assert len(set(labels)) == 3, "a poisoned row must not fuse the others"
    assert len(labels) == 3


def test_refine_labels_rejects_a_nan_centroid():
    import numpy as np

    embeddings = np.array(
        [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [np.nan, 0.0, 0.0, 0.0]],
        dtype=np.float64,
    )
    labels = refine_labels([0, 1, 2], embeddings, [True] * 3, [40.0, 40.0, 40.0])
    assert len(set(labels)) == 3


def test_minor_cluster_seconds_stays_low_in_the_measured_window():
    # The window where both calibration recordings give their known answer
    # is [2.50, 5.50], and every value in it scores identically on them --
    # so the band alone does not pin anything useful.  What the band cannot
    # see is that the two cliffs cost different amounts: over-counting is
    # visible and a pinned count fixes it, erasure is silent.  So the value
    # must sit near the LOW edge, and 3.5 is the line past which measured
    # erasure begins to appear on realistic shapes.
    assert 2.50 <= MINOR_CLUSTER_SECONDS <= 3.50


def test_a_speaker_just_above_the_floor_is_not_erased():
    # Real-shaped: four speakers from sherpa's own sample where one says a
    # little less than the rest.  At a floor of 4.0 the 3.4 s speaker was
    # fused into whoever they sounded most like; the evidence puts the cliff
    # here, not at the top of the [2.50, 5.50] band.
    labels = refine_labels(
        [0, 1, 2, 3],
        [_basis(0), _basis(1), _basis(2), _basis(3)],
        [True] * 4,
        [11.3, 5.9, 5.7, 3.4],
    )
    assert len(set(labels)) == 4


def test_a_chair_and_three_brief_panellists_stay_four_speakers():
    # The commonest meeting shape, and the one a 4.0 floor collapsed to a
    # single speaker: one person holds the floor, three introduce themselves
    # in under four seconds each.
    labels = refine_labels(
        [0, 1, 2, 3],
        [_basis(0), _basis(1), _basis(2), _basis(3)],
        [True] * 4,
        [1200.0, 3.9, 3.9, 3.9],
    )
    assert len(set(labels)) == 4


def test_the_floor_is_not_so_high_it_eats_an_ordinary_short_speaker():
    # A guard with teeth against raising the floor: four speakers holding
    # 11.3 / 7.6 / 5.9 / 5.7 s, the real shape of sherpa's own 57-second
    # sample, must all survive.  A floor of 6.0 reduces this to two.
    labels = refine_labels(
        [0, 1, 2, 3],
        [_basis(0), _basis(1), _basis(2), _basis(3)],
        [True] * 4,
        [11.3, 7.6, 5.9, 5.7],
    )
    assert len(set(labels)) == 4


def test_a_pinned_count_skips_refinement_entirely():
    # sherpa's num_clusters is a cut-at-k, so it returns at most the pinned
    # number and both stages are then floored at it: refinement cannot change
    # a single label.  It must therefore not run at all -- it used to build
    # the extractor and embed every turn to return its input unchanged, 36.7
    # MB and 16.8 s on a 64-minute file.
    turns = [_turn(0.0, 60.0, 0), _turn(61.0, 120.0, 1)]
    close = _unit(1.0, 0.06)
    built = []

    automatic = _Stub(_Extractor(dim=4), per_turn=[_basis(0), close])
    assert len({t.speaker for t in _refine_with(automatic, turns)}) == 1

    pinned = _Stub(_Extractor(dim=4), per_turn=[_basis(0), close], num_speakers=2)
    pinned._extractor_cache = None
    pinned._make_extractor = lambda: built.append(1) or _Extractor(dim=4)
    out = _refine_with(pinned, turns)
    assert out is turns, "pinned means untouched"
    assert built == [], "nothing should have been built for a no-op"


def test_refine_can_be_switched_off(caplog):
    # diarize_refine=False must give back sherpa's raw clusters untouched --
    # that is the lever for a recording whose real speakers refinement
    # merges, since with refinement on every diarize_threshold at or below
    # the default yields the same answer.
    turns = [_turn(0.0, 60.0, 0), _turn(61.0, 120.0, 1)]
    close = _unit(1.0, 0.06)
    on = _Stub(_Extractor(dim=4), per_turn=[_basis(0), close])
    off = _Stub(_Extractor(dim=4), per_turn=[_basis(0), close], refine=False)
    assert len({t.speaker for t in _refine_with(on, turns)}) == 1
    out = _refine_with(off, turns)
    assert out is turns, "switched off means untouched, not merely unmerged"


def test_refinement_reports_progress_and_closes_the_band():
    # Before this the bar sat at the top of the diarization band for the
    # whole of refinement -- 11 to 45 s, the longest un-ticked step in the
    # pipeline.  The embedding loop now carries the tail of the band.
    seen = []
    turns = [_turn(float(i) * 10, float(i) * 10 + 9, i) for i in range(4)]
    stub = _Stub(_Extractor(dim=4), vector=[1.0, 0.0, 0.0, 0.0])
    stub._refine([0.0] * 16000, turns, on_progress=seen.append)
    assert seen, "refinement emitted no progress at all"
    assert seen == sorted(seen), "progress must never walk backwards"
    assert seen[-1] == pytest.approx(1.0), "the band must close at its top"
    assert all(v >= 1.0 - SherpaDiarizer._REFINE_PROGRESS_SHARE - 1e-9 for v in seen), (
        "refinement must stay inside the tail it was given"
    )


def test_a_failing_progress_callback_cannot_cost_the_diarization():
    def boom(_fraction):
        raise RuntimeError("the renderer went away")

    turns = [_turn(0.0, 30.0, 0), _turn(31.0, 60.0, 1)]
    stub = _Stub(_Extractor(dim=4), vector=[1.0, 0.0, 0.0, 0.0])
    out = stub._refine([0.0] * 16000, turns, on_progress=boom)
    assert [t.speaker for t in out] == [0, 1], "it degrades to sherpa's labels"


def test_the_extractor_is_not_built_when_refinement_is_off():
    # Switching refinement off must avoid its cost, not merely its effect:
    # the second extractor measures +38.8 MB and 0.19 s.  It used to be
    # constructed in __init__ regardless.
    built = []

    class _Counting(_Stub):
        def __init__(self):
            super().__init__(_Extractor(dim=4), vector=[1.0, 0.0, 0.0, 0.0],
                             refine=False)
            self._extractor_cache = None
            self._make_extractor = lambda: built.append(1) or _Extractor(dim=4)

    turns = [_turn(0.0, 30.0, 0), _turn(31.0, 60.0, 1)]
    _refine_with(_Counting(), turns)
    assert built == [], "the extractor was built despite diarize_refine=False"


def test_an_extractor_that_will_not_build_cannot_cost_the_diarization(caplog):
    # The constructor used to run in __init__, outside _refine's boundary,
    # and _run_diarization has no try/except -- so a model that would not
    # load threw away a completed Whisper decode.  It is now built lazily
    # inside the boundary.
    turns = [_turn(0.0, 30.0, 0), _turn(31.0, 60.0, 1)]
    stub = _Stub(_Extractor(dim=4), extractor_raises=True)
    with caplog.at_level("WARNING"):
        out = _refine_with(stub, turns)
    assert out is turns
    assert "keeping sherpa's labels" in caplog.text


def test_the_progress_band_closes_when_a_count_is_pinned():
    # Found by end-to-end verification, not by this suite: pinning a count
    # skips refinement for a different reason than the off switch, and the
    # progress split only knew about the switch -- so the band stopped at
    # 93% of the diarization stage and stayed there.  Both routes must give
    # the engine the whole band.
    seen = []
    stub = _Stub(_Extractor(dim=4), num_speakers=6)

    class _Engine:
        def process(self, samples, callback=None):
            for i in (1, 5, 10):
                callback(i, 10)
            return self

        def sort_by_start_time(self):
            return [SpeakerTurn(0.0, 5.0, 0), SpeakerTurn(6.0, 9.0, 1)]

    stub._engine = _Engine()
    stub.diarize_samples([0.0] * 16000, on_progress=seen.append)
    assert seen[-1] == pytest.approx(1.0), f"band stopped at {seen[-1]}"


def test_the_progress_band_closes_with_refinement_switched_off():
    # With refinement off the engine owns the whole band.  Reserving the tail
    # unconditionally left the bar parked at 93% of the diarization band for
    # the rest of the stage -- 87.9% of the overall run.
    seen = []
    stub = _Stub(_Extractor(dim=4), refine=False)

    class _Engine:
        def process(self, samples, callback=None):
            for i in (1, 5, 10):
                callback(i, 10)
            return self

        def sort_by_start_time(self):
            return [SpeakerTurn(0.0, 5.0, 0), SpeakerTurn(6.0, 9.0, 1)]

    stub._engine = _Engine()
    stub.diarize_samples([0.0] * 16000, on_progress=seen.append)
    assert seen[-1] == pytest.approx(1.0), f"band stopped at {seen[-1]}"
    assert seen == sorted(seen)


def test_an_unembeddable_turn_goes_to_its_temporal_neighbour():
    # Turns arrive in time order.  A sub-gate turn sitting between two turns
    # of speaker B belongs to B, not to whoever talks most -- handing it to
    # the largest cluster was close to guessing (measured: such an embedding
    # matches its own cluster's centroid best only 9.9% of the time).
    #
    # A is the dominant speaker, B says less, and the debris turn sits in the
    # middle of B's stretch.
    labels = refine_labels(
        [0, 0, 1, 2, 1],
        [_basis(0), _basis(0), _basis(1), [0.0] * 4, _basis(1)],
        [True, True, True, False, True],
        [500.0, 500.0, 20.0, 0.4, 20.0],
    )
    assert len(set(labels)) == 2
    assert labels[3] == labels[2] == labels[4], (
        "the debris turn must join the speaker surrounding it in time"
    )
    assert labels[3] != labels[0], "not the loudest speaker in the room"


def test_an_unembeddable_turn_at_the_very_start_still_lands_somewhere():
    labels = refine_labels(
        [9, 0, 0],
        [[0.0] * 4, _basis(0), _basis(0)],
        [False, True, True],
        [0.3, 40.0, 40.0],
    )
    assert len(labels) == 3
    assert labels[0] == labels[1], "nearest in time is the turn that follows"


def test_absorption_still_uses_the_embedding_when_there_is_one():
    # Time adjacency is the fallback for turns with NO embedding; a turn that
    # has one must still go to the centroid it resembles, even if a different
    # speaker happens to sit closer in time.
    labels = refine_labels(
        [0, 1, 2, 1],
        [_basis(0), _basis(1), _basis(0), _basis(1)],
        [True] * 4,
        [60.0, 60.0, 0.5, 60.0],
    )
    assert labels[2] == labels[0], "it sounds like speaker A, so it is A"


def test_absorption_creates_merge_opportunities_so_the_stages_iterate():
    # Derived, not stumbled on.  X is the dominant speaker, Y a smaller one
    # just above the floor, and d a debris turn below it.  All three pairwise
    # cosines sit BELOW the merge threshold, so the merge stage does nothing:
    #   cos(X, Y) = 0.600   cos(d, X) = 0.500   cos(d, Y) = 0.604
    # Absorption then sends d to Y, because d resembles Y more than X, and
    # the normalised weighted sum lands at
    #   cos(X, Y') = 0.624
    # which is above the threshold.  One pass of each stage therefore leaves
    # a merge undone; only iterating to a fixed point catches it.  The same
    # shape occurs on the real 64-minute talk at merge_cosine 0.65, where one
    # pass leaves five speakers with the closest pair at 0.6585.
    X = [1.0, 0.0, 0.0, 0.0]
    Y = [0.60, 0.80, 0.0, 0.0]
    d = _unit(0.50, 0.38, 0.778)
    args = ([0, 1, 2], [X, Y, d], [True] * 3, [100.0, 4.0, 2.0])

    once = refine_labels(*args)
    assert len(set(once)) == 1, (
        "the stages must iterate: absorbing d into Y brings Y past the "
        "threshold from X, and that merge has to be taken"
    )
    twice = refine_labels(once, args[1], args[2], args[3])
    assert once == twice, "and the result must then be a fixed point"
