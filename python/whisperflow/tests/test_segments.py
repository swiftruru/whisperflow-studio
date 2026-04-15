"""Unit tests for vad/segments.py merge_timestamps."""

from __future__ import annotations

from whisperflow.vad.segments import merge_timestamps


def test_empty_input_returns_empty_list():
    assert merge_timestamps([]) == []


def test_short_gap_is_merged():
    merged = merge_timestamps(
        [
            {"start": 0.0, "end": 2.0},
            {"start": 3.0, "end": 5.0},  # 1s gap, under 5s merge window
        ],
        merge_window=5.0,
        max_merge_size=30.0,
        padding_left=0,
        padding_right=0,
    )
    assert len(merged) == 1
    assert merged[0]["start"] == 0.0
    assert merged[0]["end"] == 5.0


def test_long_gap_splits_segments():
    merged = merge_timestamps(
        [
            {"start": 0.0, "end": 2.0},
            {"start": 20.0, "end": 22.0},  # 18s gap, > merge window
        ],
        merge_window=5.0,
        max_merge_size=30.0,
        padding_left=0,
        padding_right=0,
    )
    assert len(merged) == 2


def test_max_merge_size_none_returns_input_untouched():
    data = [{"start": 0.0, "end": 1.0}, {"start": 2.0, "end": 3.0}]
    assert merge_timestamps(data, max_merge_size=None) == data


def test_padding_is_applied_to_final_segment():
    merged = merge_timestamps(
        [{"start": 10.0, "end": 12.0}],
        merge_window=5.0,
        max_merge_size=30.0,
        padding_left=0.5,
        padding_right=0.5,
    )
    assert merged[0]["start"] == 10.0 - 0.5
    assert merged[0]["end"] == 12.0 + 0.5
