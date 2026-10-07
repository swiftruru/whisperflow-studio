"""Unit tests for subtitles/writers.py (no external deps, safe to run anywhere)."""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from whisperflow.subtitles.writers import (
    SPEAKER_PREFIX_FORMAT,
    TXT_PARAGRAPH_GAP,
    _wrap_text,
    format_speaker_prefix,
    format_timestamp,
    write_srt,
    write_txt,
    write_vtt,
)


def test_format_timestamp_srt_style():
    assert format_timestamp(0.0, always_include_hours=True, fractional_separator=",") == "00:00:00,000"
    assert format_timestamp(3661.123, always_include_hours=True, fractional_separator=",") == "01:01:01,123"


def test_format_timestamp_vtt_style_omits_hours_for_short():
    assert format_timestamp(12.5) == "00:12.500"
    assert format_timestamp(3600) == "01:00:00.000"  # >= 1h forces HH:


def test_format_timestamp_rejects_negative():
    with pytest.raises(ValueError):
        format_timestamp(-0.1)


def test_write_srt_basic():
    segments = [
        {"start": 0.0, "end": 1.5, "text": "Hello world"},
        {"start": 2.0, "end": 4.25, "text": "Second cue"},
    ]
    out = io.StringIO()
    write_srt(segments, out)
    text = out.getvalue()
    assert "1\n00:00:00,000 --> 00:00:01,500\nHello world\n" in text
    assert "2\n00:00:02,000 --> 00:00:04,250\nSecond cue\n" in text


def test_write_vtt_header_and_escapes_arrow():
    segments = [{"start": 0.0, "end": 1.0, "text": "a --> b"}]
    out = io.StringIO()
    write_vtt(segments, out)
    text = out.getvalue()
    assert text.startswith("WEBVTT\n")
    assert "a -> b" in text  # --> should have been escaped


def test_write_txt_one_line_per_segment():
    segments = [
        {"start": 0.0, "end": 1.0, "text": "  line one  "},
        {"start": 1.0, "end": 2.0, "text": "line two"},
    ]
    out = io.StringIO()
    write_txt(segments, out)
    assert out.getvalue().splitlines() == ["line one", "line two"]


# --- speaker labels ------------------------------------------------------
#
# The guarantee these tests exist to protect: with diarization off, no
# segment carries a ``speaker_label`` and every writer must emit exactly
# the bytes it emitted in v1.16.7.


def test_speaker_prefix_format_constant_is_stable():
    # Mirrored by SPEAKER_PREFIX_FORMAT in src/main/subtitle-writer.js,
    # which the in-app subtitle editor uses to regenerate SRT/VTT/TXT.
    # Changing one without the other makes an edit-and-save silently
    # rewrite every cue.
    assert SPEAKER_PREFIX_FORMAT == "[{label}] "
    assert format_speaker_prefix("Speaker 1") == "[Speaker 1] "


def test_write_srt_adds_speaker_prefix():
    segments = [
        {"start": 0.0, "end": 1.5, "text": "Hello world", "speaker_label": "Speaker 1"},
        {"start": 2.0, "end": 4.25, "text": "Second cue", "speaker_label": "Speaker 2"},
    ]
    out = io.StringIO()
    write_srt(segments, out)
    assert out.getvalue() == (
        "1\n00:00:00,000 --> 00:00:01,500\n[Speaker 1] Hello world\n\n"
        "2\n00:00:02,000 --> 00:00:04,250\n[Speaker 2] Second cue\n\n"
    )


def test_write_vtt_adds_speaker_prefix_without_voice_tag():
    segments = [{"start": 0.0, "end": 1.5, "text": "Hello world", "speaker_label": "Speaker 1"}]
    out = io.StringIO()
    write_vtt(segments, out)
    text = out.getvalue()
    assert text == "WEBVTT\n\n00:00.000 --> 00:01.500\n[Speaker 1] Hello world\n\n"
    # No <v> tag: the app previews VTT through its SRT parser, which would
    # render the tag verbatim instead of interpreting it.
    assert "<v" not in text


def test_write_txt_adds_speaker_prefix():
    segments = [
        {"start": 0.0, "end": 1.0, "text": "line one", "speaker_label": "Speaker 1"},
        {"start": 1.0, "end": 2.0, "text": "line two", "speaker_label": "Speaker 2"},
    ]
    out = io.StringIO()
    write_txt(segments, out)
    assert out.getvalue().splitlines() == ["[Speaker 1] line one", "[Speaker 2] line two"]


def test_no_prefix_when_label_absent_is_byte_identical():
    # Byte-for-byte the v1.16.7 output.  This is the regression guard for
    # "diarization off => nothing changes".
    segments = [
        {"start": 0.0, "end": 1.5, "text": "Hello world"},
        {"start": 2.0, "end": 4.25, "text": "Second cue"},
    ]
    srt, vtt, txt = io.StringIO(), io.StringIO(), io.StringIO()
    write_srt(segments, srt)
    write_vtt(segments, vtt)
    write_txt(segments, txt)
    assert srt.getvalue() == (
        "1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n"
        "2\n00:00:02,000 --> 00:00:04,250\nSecond cue\n\n"
    )
    assert vtt.getvalue() == (
        "WEBVTT\n\n"
        "00:00.000 --> 00:01.500\nHello world\n\n"
        "00:02.000 --> 00:04.250\nSecond cue\n\n"
    )
    assert txt.getvalue() == "Hello world\nSecond cue\n"


def test_blank_speaker_label_adds_no_prefix():
    for label in (None, "", "   "):
        segments = [{"start": 0.0, "end": 1.0, "text": "Hello", "speaker_label": label}]
        out = io.StringIO()
        write_srt(segments, out)
        assert out.getvalue() == "1\n00:00:00,000 --> 00:00:01,000\nHello\n\n", label
        assert format_speaker_prefix(label) == ""


def test_empty_text_segment_gets_no_prefix():
    # A blank cue body stays blank rather than becoming a bare label.
    segments = [{"start": 0.0, "end": 1.0, "text": "   ", "speaker_label": "Speaker 1"}]
    out = io.StringIO()
    write_srt(segments, out)
    assert out.getvalue() == "1\n00:00:00,000 --> 00:00:01,000\n\n\n"


def test_speaker_prefix_counts_toward_first_line_width():
    # The 12-character prefix is charged to line 1, so the same text that
    # fits on one line without a label has to wrap with one.
    assert _wrap_text("Hello there friend", 20) == "Hello there friend"
    assert (
        _wrap_text("Hello there friend", 20, prefix="[Speaker 1] ")
        == "[Speaker 1] Hello\nthere friend"
    )


def test_speaker_label_alone_never_occupies_a_whole_line():
    # Degenerate case: the label is longer than max_line_width.  We still
    # put the first word next to it rather than emitting a label-only line.
    assert _wrap_text("Hello world", 4, prefix="[Speaker 1] ") == "[Speaker 1] Hello\nworld"


def test_speaker_label_arrow_is_escaped():
    segments = [{"start": 0.0, "end": 1.0, "text": "hi", "speaker_label": "a-->b"}]
    out = io.StringIO()
    write_srt(segments, out)
    assert "[a->b] hi" in out.getvalue()


def test_words_present_does_not_change_cue_text():
    # Cue text always comes from segment["text"], never from re-joining
    # word tokens.  Joining them is what used to turn Chinese subtitles
    # into "你 好 世 界" once word_timestamps was enabled.
    segments = [
        {
            "start": 0.0,
            "end": 1.0,
            "text": "你好世界",
            "words": [
                {"start": i * 0.2, "end": (i + 1) * 0.2, "word": char, "probability": 1.0}
                for i, char in enumerate("你好世界")
            ],
        }
    ]
    out = io.StringIO()
    write_srt(segments, out)
    assert out.getvalue() == "1\n00:00:00,000 --> 00:00:01,000\n你好世界\n\n"


# --- wrapping keeps the words apart -------------------------------------


def test_wrapping_preserves_the_space_between_words():
    # Before v1.17 this returned "Hellotherefriend": the tokens were
    # concatenated with no separator.  It went unnoticed because
    # max_line_width ships blank, so no shipped configuration reached the
    # wrapping path at all.
    assert _wrap_text("Hello there friend", 42) == "Hello there friend"
    assert _wrap_text("Hello there friend", 10) == "Hello\nthere\nfriend"


def test_wrapping_preserves_a_double_space():
    assert _wrap_text("alpha  bravo  charlie", 14) == "alpha  bravo\ncharlie"
    assert _wrap_text("a  b", 10) == "a  b"


def test_wrapping_never_leaves_a_trailing_space_on_a_line():
    for width in range(3, 25):
        for line in _wrap_text("alpha  bravo  charlie delta", width).split("\n"):
            assert line == line.rstrip(), (width, repr(line))


def test_wrapping_never_emits_a_blank_line():
    # A blank line would end the cue block and truncate the file.
    for width in range(1, 20):
        wrapped = _wrap_text("alpha \t bravo \t charlie", width)
        assert "\n\n" not in wrapped, (width, repr(wrapped))
        assert all(line.strip() for line in wrapped.split("\n")), (width, repr(wrapped))


def test_wrapped_lines_respect_the_width_except_for_an_oversized_word():
    text = "alpha bravo charlie delta echo"
    for width in range(8, 30):
        for line in _wrap_text(text, width).split("\n"):
            assert len(line) <= width or " " not in line, (width, repr(line))


# --- the blank-line guard -----------------------------------------------


def test_a_blank_line_inside_a_cue_is_collapsed_not_written_out():
    # Left alone, the blank line terminates the SRT cue block and
    # transcript-reader.js drops everything after it with no error.
    # Collapsing is preferred over raising: a cosmetic defect should not
    # throw away a whole transcription.
    segments = [
        {"start": 0.0, "end": 1.0, "text": "a\n\nb"},
        {"start": 2.0, "end": 3.0, "text": "next"},
    ]
    out = io.StringIO()
    write_srt(segments, out)
    text = out.getvalue()
    assert "a\nb" in text
    assert "next" in text, "the cue after the offending one must survive"
    # Exactly two cue blocks, so the structure is intact.
    assert text.count(" --> ") == 2
    blocks = [block for block in text.split("\n\n") if block.strip()]
    assert len(blocks) == 2


def test_a_legal_two_line_cue_passes_through_untouched():
    segments = [{"start": 0.0, "end": 1.0, "text": "line one\nline two"}]
    out = io.StringIO()
    write_srt(segments, out)
    assert out.getvalue() == "1\n00:00:00,000 --> 00:00:01,000\nline one\nline two\n\n"


def test_a_two_line_cue_keeps_its_speaker_prefix_on_the_first_line():
    segments = [
        {"start": 0.0, "end": 1.0, "text": "line one\nline two", "speaker_label": "Speaker 1"}
    ]
    out = io.StringIO()
    write_vtt(segments, out)
    assert "[Speaker 1] line one\nline two" in out.getvalue()


# --- TXT paragraphs, against the cross-language contract ----------------
#
# tests/fixtures/txt-paragraphs.json is hand-written and read by BOTH this
# file and tests/unit/subtitle-writer.test.js, which compare their own
# output against the same `expected` strings.  Python writes the TXT and
# the in-app editor regenerates it, so the two have to agree byte for
# byte or the first save silently re-paragraphs the file.


def _contract() -> dict:
    # parents[3] because CI runs pytest with working-directory: python, so
    # a relative path would fail only on CI.
    path = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "txt-paragraphs.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_txt_paragraph_gap_matches_the_contract():
    assert TXT_PARAGRAPH_GAP == _contract()["paragraphGapSeconds"]


def test_txt_matches_the_shared_contract():
    cases = _contract()["cases"]
    assert len(cases) >= 10, "the contract should not have been quietly emptied"
    for case in cases:
        out = io.StringIO()
        write_txt(case["segments"], out, paragraphs=case["paragraphs"])
        assert out.getvalue() == case["expected"], case["name"]


def test_write_txt_defaults_to_one_line_per_segment():
    # The legacy branch is untouched code, not a reimplementation, so
    # segmentation-off TXT output is byte-identical.
    segments = [
        {"start": 0.0, "end": 1.0, "text": "line one", "speaker": 0, "speaker_label": "Speaker 1"},
        {"start": 1.0, "end": 2.0, "text": "line two", "speaker": 0},
    ]
    default_out, explicit_out = io.StringIO(), io.StringIO()
    write_txt(segments, default_out)
    write_txt(segments, explicit_out, paragraphs=False)
    assert default_out.getvalue() == explicit_out.getvalue()
    assert default_out.getvalue() == "[Speaker 1] line one\nline two\n"
