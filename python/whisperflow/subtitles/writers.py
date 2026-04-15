# Rewritten from faster-whisper-webui src/utils.py (Apache 2.0, (c) aadnk).
# Changes: removed download_file, slugify, CLI arg helpers, diarization's
# "longest_speaker" injection, word-highlight mode, and textwrap process_text.
# This module now contains ONLY the subtitle writers used by the core
# transcription path.  See /NOTICES.md in the repo root for license details.

from __future__ import annotations

from typing import Iterable, Iterator, Mapping, Optional, TextIO

Segment = Mapping[str, object]


def format_timestamp(
    seconds: float,
    *,
    always_include_hours: bool = False,
    fractional_separator: str = ".",
) -> str:
    """Format a duration in seconds as ``HH:MM:SS<sep>mmm``.

    ``always_include_hours=True`` forces the leading ``HH:`` block even when
    the duration is under an hour (SRT requires it, VTT doesn't).
    """
    if seconds < 0:
        raise ValueError(f"timestamp must be non-negative, got {seconds}")

    total_ms = round(seconds * 1000.0)
    hours, total_ms = divmod(total_ms, 3_600_000)
    minutes, total_ms = divmod(total_ms, 60_000)
    secs, millis = divmod(total_ms, 1_000)

    hours_block = f"{hours:02d}:" if always_include_hours or hours > 0 else ""
    return f"{hours_block}{minutes:02d}:{secs:02d}{fractional_separator}{millis:03d}"


def write_txt(segments: Iterable[Segment], file: TextIO) -> None:
    """Write plain-text transcript, one segment per line."""
    for segment in segments:
        text = str(segment.get("text", "")).strip()
        print(text, file=file, flush=True)


def write_vtt(
    segments: Iterable[Segment],
    file: TextIO,
    *,
    max_line_width: Optional[int] = None,
) -> None:
    """Write WebVTT transcript."""
    print("WEBVTT\n", file=file)
    for cue in _prepare_cues(segments, max_line_width):
        text = cue["text"].replace("-->", "->")
        start = format_timestamp(cue["start"])
        end = format_timestamp(cue["end"])
        print(f"{start} --> {end}\n{text}\n", file=file, flush=True)


def write_srt(
    segments: Iterable[Segment],
    file: TextIO,
    *,
    max_line_width: Optional[int] = None,
) -> None:
    """Write SRT transcript (1-indexed, always includes HH:)."""
    for index, cue in enumerate(_prepare_cues(segments, max_line_width), start=1):
        text = cue["text"].replace("-->", "->")
        start = format_timestamp(cue["start"], always_include_hours=True, fractional_separator=",")
        end = format_timestamp(cue["end"], always_include_hours=True, fractional_separator=",")
        print(f"{index}\n{start} --> {end}\n{text}\n", file=file, flush=True)


def _prepare_cues(
    segments: Iterable[Segment],
    max_line_width: Optional[int],
) -> Iterator[dict]:
    """Yield ``{start, end, text}`` dicts ready to be serialized.

    Handles word-level timestamps by joining them into a single cue and, if
    ``max_line_width`` is set, wrapping words across lines without breaking
    them mid-word (preserves Whisper's leading-space convention).
    """
    for segment in segments:
        words = segment.get("words") or []

        if not words:
            text = str(segment.get("text", "")).strip()
            yield {
                "start": float(segment["start"]),
                "end": float(segment["end"]),
                "text": _wrap_text(text, max_line_width),
            }
            continue

        word_texts = [str(w["word"]) for w in words]
        yield {
            "start": float(segment["start"]),
            "end": float(segment["end"]),
            "text": _wrap_words(word_texts, max_line_width),
        }


def _wrap_text(text: str, max_line_width: Optional[int]) -> str:
    if max_line_width is None or max_line_width <= 0:
        return text
    # Word-wrap by splitting on whitespace while preserving it where possible.
    return _wrap_words(text.split(" "), max_line_width)


def _wrap_words(words: Iterable[str], max_line_width: Optional[int]) -> str:
    if max_line_width is None or max_line_width <= 0:
        return "".join(words) if any(w.startswith(" ") for w in words) else " ".join(words)

    lines: list[str] = []
    current = ""
    current_length = 0

    for word in words:
        word_length = len(word)
        if current_length > 0 and current_length + word_length > max_line_width:
            lines.append(current)
            current = ""
            current_length = 0
        current += word
        current_length += word_length

    if current:
        lines.append(current)
    return "\n".join(lines)
