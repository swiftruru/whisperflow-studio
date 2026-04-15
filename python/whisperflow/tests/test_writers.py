"""Unit tests for subtitles/writers.py (no external deps, safe to run anywhere)."""

from __future__ import annotations

import io

import pytest

from whisperflow.subtitles.writers import format_timestamp, write_srt, write_txt, write_vtt


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
