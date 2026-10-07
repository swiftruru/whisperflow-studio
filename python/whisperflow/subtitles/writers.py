# Rewritten from faster-whisper-webui src/utils.py (Apache 2.0, (c) aadnk).
# Changes: removed download_file, slugify, CLI arg helpers, upstream
# diarization's "longest_speaker" injection, word-highlight mode, and
# textwrap process_text.  This module contains ONLY the subtitle writers
# used by the core transcription path, plus WhisperFlow's own speaker-label
# prefixing (see ``SPEAKER_PREFIX_FORMAT``).
# See /NOTICES.md in the repo root for license details.

from __future__ import annotations

import logging
import re
from typing import Iterable, Iterator, Mapping, Optional, TextIO

_log = logging.getLogger(__name__)

Segment = Mapping[str, object]

# A blank line terminates an SRT or WebVTT cue block, so one inside a cue
# body truncates the file: src/main/transcript-reader.js splits blocks on
# /\n\s*\n+/ and silently drops everything after the break.  Nothing
# upstream should produce one -- segmentation's wrapper cannot, and
# _wrap_tokens below skips blank lines -- but the cost of being wrong is
# losing the tail of a transcript with no error anywhere, so the writers
# collapse them rather than trusting their callers.
_BLANK_LINES = re.compile(r"\n[ \t]*(?:\n[ \t]*)+")

# Rendered in front of the first line of a cue whose segment carries a
# ``speaker_label``.
#
# KEEP IN SYNC with SPEAKER_PREFIX_FORMAT in src/main/subtitle-writer.js:
# the in-app subtitle editor regenerates SRT/VTT/TXT from edited segments,
# so both implementations have to produce the same bytes.  Pinned by
# tests/test_writers.py::test_speaker_prefix_format_constant_is_stable.
SPEAKER_PREFIX_FORMAT = "[{label}] "


def format_speaker_prefix(label: object) -> str:
    """Return ``"[Speaker 1] "`` for a non-blank label, ``""`` otherwise.

    Every writer below prepends this unconditionally, so returning ``""``
    for a missing or blank label is what keeps the output byte-identical
    when diarization is off.
    """
    if label is None:
        return ""
    text = str(label).strip()
    if not text:
        return ""
    return SPEAKER_PREFIX_FORMAT.format(label=text)


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
        # Gate the prefix on non-empty text so a blank segment still writes
        # a blank line rather than a bare label.
        prefix = format_speaker_prefix(segment.get("speaker_label")) if text else ""
        print(f"{prefix}{text}", file=file, flush=True)


def write_vtt(
    segments: Iterable[Segment],
    file: TextIO,
    *,
    max_line_width: Optional[int] = None,
) -> None:
    """Write WebVTT transcript.

    Speaker labels are written as a plain ``[label] `` text prefix, never as
    a ``<v>`` tag: the app's own VTT preview parses cues with the SRT
    parser, which would show the tag verbatim.
    """
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

    A segment carrying a ``speaker_label`` gains a ``[label] `` prefix that
    counts towards the first line's width.  The segment's own ``text`` is
    never modified, which is what keeps the JSON output free of speaker
    markup — nothing downstream ever has to parse a label back out of a
    subtitle line (Whisper emits ``[Music]`` / ``[音樂]`` of its own, so
    such parsing would be ambiguous by construction).

    Cue text always comes from ``segment["text"]``.  Word-level timestamps
    are deliberately *not* re-joined here: ``diarization.assign_speakers()``
    already rebuilds ``text`` for each piece it splits off, and joining word
    tokens cannot be done correctly without knowing the language's word
    separator (for CJK it would insert spaces that do not belong).
    """
    for segment in segments:
        text = str(segment.get("text", "")).strip()
        prefix = format_speaker_prefix(segment.get("speaker_label")) if text else ""
        yield {
            "start": float(segment["start"]),
            "end": float(segment["end"]),
            "text": _collapse_blank_lines(_wrap_text(text, max_line_width, prefix=prefix)),
        }


def _collapse_blank_lines(text: str) -> str:
    """Fold any run of blank lines inside a cue body down to one break.

    See ``_BLANK_LINES``: a blank line ends the cue block, so leaving one
    in costs the reader everything after it with no error raised anywhere.
    Collapsing is deliberately preferred over raising -- a cosmetic defect
    should not throw away a whole transcription -- but it is logged,
    because reaching here means something upstream is wrong.
    """
    if not _BLANK_LINES.search(text):
        return text
    _log.warning("collapsing a blank line inside a subtitle cue: %r", text)
    return _BLANK_LINES.sub("\n", text)


def _wrap_text(text: str, max_line_width: Optional[int], *, prefix: str = "") -> str:
    if max_line_width is None or max_line_width <= 0:
        return f"{prefix}{text}"
    # Word-wrap by splitting on whitespace while preserving it where possible.
    return _wrap_tokens(text.split(" "), max_line_width, prefix=prefix)


def _wrap_tokens(
    tokens: Iterable[str],
    max_line_width: int,
    *,
    prefix: str = "",
) -> str:
    """Greedily pack ``tokens`` into lines of at most ``max_line_width``.

    ``prefix`` seeds the first line, so a speaker label eats into the room
    available for the first line's words.  A token longer than
    ``max_line_width`` overflows rather than being split mid-word.

    Tokens are rejoined with a single space.  Before v1.17 they were
    concatenated with no separator at all, so wrapping turned
    "Hello there friend" into "Hellotherefriend" — unnoticed only because
    ``max_line_width`` ships blank, so no shipped configuration ever
    reached this path.
    """
    lines: list[str] = []
    current = prefix
    # Never emit a line holding nothing but the speaker label, however
    # small max_line_width is.
    prefix_only = bool(prefix)

    for token in tokens:
        # One space between tokens, except where it would be leading: at
        # the start of a line, or straight after the prefix, which already
        # ends in one.
        separator = "" if (not current or prefix_only) else " "
        if (
            current
            and not prefix_only
            and len(current) + len(separator) + len(token) > max_line_width
        ):
            flushed = current.rstrip()
            # Dropping a whitespace-only line loses nothing a viewer could
            # see; emitting one would put a blank line inside the cue and
            # truncate the file.
            if flushed:
                lines.append(flushed)
            current = token
        else:
            current = f"{current}{separator}{token}"
        prefix_only = False

    flushed = current.rstrip()
    if flushed:
        lines.append(flushed)
    return "\n".join(lines)
