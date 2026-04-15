# Rewritten from faster-whisper-webui src/segments.py (Apache 2.0, (c) aadnk).
# Changes: type hints, doc-comments, explicit input validation, and the merge
# loop is no longer index-based.  Behaviour matches the original.
# See /NOTICES.md for license details.

from __future__ import annotations

import copy
from typing import Iterable, Optional, TypedDict


class TimeSegment(TypedDict, total=False):
    start: float
    end: float


def merge_timestamps(
    timestamps: Iterable[TimeSegment],
    *,
    merge_window: Optional[float] = 5.0,
    max_merge_size: Optional[float] = 30.0,
    padding_left: Optional[float] = 1.0,
    padding_right: Optional[float] = 1.0,
) -> list[TimeSegment]:
    """Merge adjacent speech segments that are separated by short silences.

    Two consecutive segments are fused when the silence gap between them is
    at most ``merge_window`` seconds AND the resulting segment would still be
    shorter than ``max_merge_size`` seconds.  ``padding_left`` / ``padding_right``
    extend each finalised segment into its neighbouring silence (without
    overlapping the next segment's start).

    Passing ``max_merge_size=None`` short-circuits and returns the input
    untouched, matching the upstream contract.
    """
    segments = list(timestamps)
    if not segments:
        return []
    if max_merge_size is None:
        return segments

    left_pad = padding_left or 0.0
    right_pad = padding_right or 0.0

    merged: list[TimeSegment] = []
    current: Optional[TimeSegment] = None
    processed_time = 0.0

    for nxt in segments:
        delta = nxt["start"] - processed_time

        should_break = (
            current is None
            or (merge_window is not None and delta > merge_window)
            or (nxt["end"] - current["start"] > max_merge_size)
        )

        if should_break:
            if current is not None:
                # Give the just-finished segment its right padding, but don't
                # let it overlap into the next segment's padding zone.
                finish_pad = min(right_pad, delta / 2) if delta < left_pad + right_pad else right_pad
                current["end"] += finish_pad
                delta -= finish_pad
                merged.append(current)

            current = copy.deepcopy(nxt)
            current["start"] = current["start"] - min(left_pad, delta)
            processed_time = current["end"]
        else:
            # Merge: extend the current segment's tail.
            assert current is not None  # narrowed by the guard above
            current["end"] = nxt["end"]
            processed_time = current["end"]

    if current is not None:
        current["end"] += right_pad
        merged.append(current)

    return merged
