# New module (no upstream counterpart).
# Re-cuts Whisper's segments into subtitle-sized cues using word
# timestamps: at most two lines per cue, at most seven seconds, within a
# reading-speed budget, never spanning two speakers.  Industry norms and
# the measured figures behind the constants are in
# docs/specs/subtitle-segmentation.md.
#
# Zero third-party imports -- not even numpy.  The algorithm needs no
# arrays, and CI installs only pytest/ffmpeg-python/numpy, so keeping this
# module stdlib-only is what makes it fully unit-testable.  (transcriber.py
# imports faster_whisper at module level and therefore cannot be imported
# on CI at all; every piece of logic that needs a test lives here.)

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import asdict, dataclass
from typing import Callable, Mapping, Optional, Sequence

from .writers import format_speaker_prefix

_log = logging.getLogger(__name__)

_INFINITY = float("inf")


# --- character width ----------------------------------------------------
#
# Everything internal is measured in half-width columns: a Latin character
# is 1, a full-width CJK character is 2.  That single unit lets mixed
# Chinese/English text be measured without a second knob -- the user-facing
# limit stays in the language's own unit (42 Latin characters / 16 CJK
# characters, the published Netflix figures) and is converted once in
# resolve_limits().


# A transcript reuses the same few hundred characters over and over, and
# the width of a character never changes, so this is memoised: profiling
# an hour of speech showed char_columns dominating everything else.
_COLUMN_CACHE: dict[str, int] = {}


def char_columns(char: str) -> int:
    """Half-width columns one character occupies.

    East Asian Wide/Fullwidth -> 2, combining marks -> 0, everything else
    -> 1.  "Ambiguous" width (``±``, ``§``, arrows) counts as 1, matching
    docs/specs/segmentation_reference.py -- that is the one arbitrary call
    in here, and it is kept identical to the validated reference.
    """
    cached = _COLUMN_CACHE.get(char)
    if cached is None:
        if unicodedata.combining(char):
            cached = 0
        else:
            cached = 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
        _COLUMN_CACHE[char] = cached
    return cached


def text_columns(text: str) -> int:
    return sum(char_columns(char) for char in text)


# --- language profiles --------------------------------------------------

# Validated word lists from docs/specs/segmentation_reference.py.  They
# only ever match English; for other Latin-script languages the
# punctuation and pause terms carry the work on their own.
_GOOD_START = frozenset(
    """and but so because which then if that or when where while to in on at
    for with from of near inside around into within like using based""".split()
)
_BAD_END = frozenset(
    """the a an of to in on at for with from near by into my your our their
    this these those""".split()
)
_NEVER_END = frozenset(("the", "a", "an"))

# Characters that may not open a line (closing punctuation) or close one
# (opening punctuation).  A minimal kinsoku set -- only relevant for CJK,
# where every character boundary is otherwise a legal break.
_NO_LINE_START = frozenset("。，、；：！？）］｝」』〉》…·.,;:!?)]}%")
_NO_LINE_END = frozenset("（［｛「『〈《([{")

CJK_LANGUAGE_CODES = frozenset(("zh", "ja", "ko", "yue"))


@dataclass(frozen=True)
class LanguageProfile:
    """Per-script segmentation rules.

    ``default_line_chars`` and ``chars_per_second`` are in the language's
    own character unit, not columns -- see resolve_limits().
    """

    code: str
    cjk: bool
    default_line_chars: int
    chars_per_second: float
    sentence_final: str
    comma_like: str
    good_start: frozenset
    bad_end: frozenset
    never_end: frozenset


LATIN_PROFILE = LanguageProfile(
    code="",
    cjk=False,
    default_line_chars=42,
    chars_per_second=20.0,
    sentence_final=".?!…",
    comma_like=",;:",
    good_start=_GOOD_START,
    bad_end=_BAD_END,
    never_end=_NEVER_END,
)

# Japanese and Korean have their own published figures; v1 shares the
# Chinese rules and says so in the Settings description.
CJK_PROFILE = LanguageProfile(
    code="zh",
    cjk=True,
    default_line_chars=16,
    chars_per_second=9.0,
    sentence_final="。！？…!?.",
    comma_like="，、；：,;:",
    good_start=frozenset(),
    bad_end=frozenset(),
    never_end=frozenset(),
)


def profile_for(language: Optional[str]) -> LanguageProfile:
    """Pick a profile from an ISO code ("zh") or a display name ("Chinese").

    ``result["language"]`` gives a code, ``config.language`` gives a name,
    and an unknown or empty value falls back to the Latin profile.
    """
    if not language:
        return LATIN_PROFILE
    code: Optional[str]
    try:
        from ..languages import resolve_language_code

        code = resolve_language_code(str(language))
    except Exception:
        # resolve_language_code raises on an unrecognised non-empty value.
        code = str(language).strip().lower()[:2] or None
    if code and code.lower() in CJK_LANGUAGE_CODES:
        return CJK_PROFILE
    return LATIN_PROFILE


# --- options and resolved limits ---------------------------------------


@dataclass(frozen=True)
class SegmentationOptions:
    """User-facing knobs, in the units the Settings panel uses."""

    max_line_chars: Optional[int] = None  # None/0 -> the profile default
    max_lines: int = 2
    max_duration: float = 7.0
    min_duration: float = 5 / 6
    min_gap: float = 0.084  # two frames at 23.976 fps
    run_gap: float = 1.0
    pause_bonus_gap: float = 0.3

    def __post_init__(self) -> None:
        # Clamped here rather than at the call site because config's
        # _coerce_value turns a blank Settings field into 0 for a bare int
        # and 0.0 for a bare float.  max_lines=0 would make every cue
        # infeasible and the escape hatch would emit one cue per word.
        object.__setattr__(self, "max_lines", max(1, int(self.max_lines or 2)))
        object.__setattr__(self, "max_duration", max(0.5, float(self.max_duration or 7.0)))
        object.__setattr__(self, "min_duration", max(0.0, float(self.min_duration or 0.0)))
        object.__setattr__(self, "min_gap", max(0.0, float(self.min_gap or 0.0)))
        object.__setattr__(self, "run_gap", max(0.0, float(self.run_gap or 0.0)))
        object.__setattr__(
            self, "pause_bonus_gap", max(0.01, float(self.pause_bonus_gap or 0.3))
        )
        chars = self.max_line_chars
        object.__setattr__(
            self, "max_line_chars", int(chars) if chars and int(chars) > 0 else None
        )
        if self.min_duration > self.max_duration:
            object.__setattr__(self, "min_duration", self.max_duration)


@dataclass(frozen=True)
class Limits:
    """Options resolved against a profile.  Every width is in columns."""

    profile: LanguageProfile
    line_chars: int
    line_columns: int
    cue_columns: int
    columns_per_second: float
    max_lines: int
    max_duration: float
    min_duration: float
    min_gap: float
    run_gap: float
    pause_bonus_gap: float


def resolve_limits(options: SegmentationOptions, language: Optional[str] = None) -> Limits:
    profile = profile_for(language)
    scale = 2 if profile.cjk else 1
    line_chars = options.max_line_chars or profile.default_line_chars
    line_columns = max(1, line_chars * scale)
    return Limits(
        profile=profile,
        line_chars=line_chars,
        line_columns=line_columns,
        cue_columns=line_columns * options.max_lines,
        columns_per_second=profile.chars_per_second * scale,
        max_lines=options.max_lines,
        max_duration=options.max_duration,
        min_duration=options.min_duration,
        min_gap=options.min_gap,
        run_gap=options.run_gap,
        pause_bonus_gap=options.pause_bonus_gap,
    )


# --- line wrapping ------------------------------------------------------
#
# Costs are normalised so a width term is ~1: a line's squared fill ratio
# is in [0, 1], which lets the punctuation bonuses below be read as
# fractions of "one badly balanced line".

_WRAP_BALANCE = 1.0
_WRAP_EXTRA_LINE = 0.35
_WRAP_SENTENCE_END = -0.30
_WRAP_COMMA_END = -0.18
_WRAP_GOOD_START = -0.08
_WRAP_BAD_END = 0.22
_WRAP_NEVER_END = 0.80

_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


def _last_word(text: str) -> str:
    words = _WORD_RE.findall(text)
    return words[-1].lower() if words else ""


def _first_word(text: str) -> str:
    match = _WORD_RE.search(text)
    return match.group(0).lower() if match else ""


def _break_quality(left: str, right: str, profile: LanguageProfile) -> float:
    """Cost adjustment for breaking between ``left`` and ``right``.

    Negative is better.  Ordering follows the Netflix guide: after
    punctuation, before a conjunction or preposition, and never leaving an
    article stranded at the end of a line.
    """
    left = left.rstrip()
    if not left:
        return 0.0
    cost = 0.0
    if left[-1] in profile.sentence_final:
        cost += _WRAP_SENTENCE_END
    elif left[-1] in profile.comma_like:
        cost += _WRAP_COMMA_END
    tail = _last_word(left)
    if tail in profile.never_end:
        cost += _WRAP_NEVER_END
    elif tail in profile.bad_end:
        cost += _WRAP_BAD_END
    if _first_word(right) in profile.good_start:
        cost += _WRAP_GOOD_START
    return cost


def _break_candidates(text: str, cjk: bool) -> list[tuple[int, int]]:
    """Legal line-break positions as ``(left_end, right_start)`` pairs.

    Whitespace runs are always breakable and are consumed by the break.
    For CJK every other character boundary is breakable too (spec 4.3:
    任兩個字之間都可以切), minus a small kinsoku set so closing
    punctuation never opens a line and opening punctuation never closes
    one.  For Latin scripts only whitespace qualifies, so a word is never
    split.
    """
    out: list[tuple[int, int]] = []
    length = len(text)

    index = 0
    while index < length:
        if text[index].isspace():
            end = index
            while end < length and text[end].isspace():
                end += 1
            if index > 0 and end < length:
                out.append((index, end))
            index = end
            continue
        index += 1

    if cjk:
        for position in range(1, length):
            if text[position].isspace() or text[position - 1].isspace():
                continue  # already offered by the whitespace pass
            if text[position] in _NO_LINE_START or text[position - 1] in _NO_LINE_END:
                continue
            out.append((position, position))
        out.sort()

    return out


def wrap_text(
    text: str,
    *,
    max_columns: int,
    max_lines: int = 2,
    prefix_columns: int = 0,
    cjk: bool = False,
    profile: Optional[LanguageProfile] = None,
) -> Optional[str]:
    """Break ``text`` into at most ``max_lines`` lines, joined with "\\n".

    Lines are as equal as possible, preferring breaks after punctuation
    and before conjunctions.  ``prefix_columns`` is charged to the first
    line, so a speaker label eats into its budget.

    Returns ``None`` when no legal break exists -- the caller must split
    the cue instead.  Never returns a blank line, never more than
    ``max_lines`` lines, and never contains "\\n\\n" (which would
    terminate an SRT/VTT cue block and silently truncate the file).
    """
    profile = profile or (CJK_PROFILE if cjk else LATIN_PROFILE)
    text = text.strip()
    if not text:
        return ""

    if text_columns(text) + prefix_columns <= max_columns:
        return text
    if max_lines <= 1:
        return None

    candidates = _break_candidates(text, profile.cjk)
    if not candidates:
        return None

    # Cumulative widths, so measuring any substring is O(1).  Breaks
    # always land on a whitespace run or a non-whitespace boundary, so a
    # substring between two break points never has whitespace at either
    # end and its width is a plain difference.
    cumulative = [0] * (len(text) + 1)
    for index, char in enumerate(text):
        cumulative[index + 1] = cumulative[index] + char_columns(char)

    memo: dict[tuple[int, int], tuple[float, Optional[list[str]]]] = {}

    def solve(start: int, lines_left: int, first: bool) -> tuple[float, Optional[list[str]]]:
        key = (start, lines_left)
        if key in memo:
            return memo[key]

        own_prefix = prefix_columns if first else 0
        best: tuple[float, Optional[list[str]]] = (_INFINITY, None)

        rest_columns = cumulative[len(text)] - cumulative[start] + own_prefix
        if start < len(text) and rest_columns <= max_columns:
            best = (
                _WRAP_BALANCE * (rest_columns / max_columns) ** 2,
                [text[start:]],
            )

        if lines_left > 1:
            for left_end, right_start in candidates:
                if left_end <= start:
                    continue
                left_columns = cumulative[left_end] - cumulative[start] + own_prefix
                # Candidates are sorted, so once the left side overflows
                # every later one does too.
                if left_columns > max_columns:
                    break
                left = text[start:left_end]
                if not left.strip():
                    continue
                tail_cost, tail_lines = solve(right_start, lines_left - 1, False)
                if tail_lines is None:
                    continue
                cost = (
                    tail_cost
                    + _WRAP_BALANCE * (left_columns / max_columns) ** 2
                    + _WRAP_EXTRA_LINE
                    + _break_quality(left, text[right_start:], profile)
                )
                if cost < best[0]:
                    best = (cost, [left] + tail_lines)

        memo[key] = best
        return best

    _, lines = solve(0, max_lines, True)
    if lines is None:
        return None
    # strip() per line keeps a trailing space from inflating a width and
    # guarantees no line is blank, so "\n\n" is unreachable.
    cleaned = [line.strip() for line in lines]
    if any(not line for line in cleaned):
        return None
    return "\n".join(cleaned)


# --- tokens and runs ----------------------------------------------------


@dataclass
class _Tok:
    """One word, with both widths it can contribute.

    faster-whisper's Latin words carry their own leading space (``" we"``)
    and its CJK words carry none.  ``columns_tail`` counts the space
    because the word sits mid-line; ``columns_head`` does not, because the
    word opens a line or a cue.  Keeping both is what makes "every line is
    at most 42 columns" literally true rather than approximately true.
    """

    text: str
    start: float
    end: float
    speaker: Optional[int]
    source: dict
    columns_tail: int
    columns_head: int


def _make_token(word: Mapping[str, object], speaker: Optional[int]) -> Optional[_Tok]:
    text = str(word.get("word", ""))
    if not text:
        return None
    try:
        start = float(word.get("start", 0.0) or 0.0)
        end = float(word.get("end", 0.0) or 0.0)
    except (TypeError, ValueError):
        return None
    return _Tok(
        text=text,
        start=start,
        end=end,
        speaker=speaker,
        source=dict(word),
        columns_tail=text_columns(text),
        columns_head=text_columns(text.lstrip()),
    )


def interpolate_words(segment: Mapping[str, object]) -> list[dict]:
    """Synthesize pseudo-words for a segment Whisper left without them.

    Times are spread across the segment's span by cumulative printable
    width, which is the same estimation docs/specs/segmentation_reference.py
    used before word timestamps were available.  Text conservation for
    these segments is defined against ``segment["text"].rstrip()``, since
    the writers strip anyway.

    ``re.findall`` keeps the leading whitespace ON each token, mirroring
    faster-whisper's own convention, so ``"".join(...)`` round-trips.
    """
    text = str(segment.get("text", "")).rstrip()
    if not text:
        return []
    start = float(segment.get("start", 0.0) or 0.0)
    end = float(segment.get("end", start) or start)
    span = max(0.0, end - start)

    tokens = re.findall(r"\s*\S+", text) if re.search(r"\S\s+\S", text) else list(text)
    total = sum(text_columns(token) for token in tokens) or 1

    words: list[dict] = []
    consumed = 0
    for token in tokens:
        token_start = start + span * consumed / total
        consumed += text_columns(token)
        token_end = start + span * consumed / total
        words.append(
            {
                "start": token_start,
                "end": token_end,
                "word": token,
                "probability": None,
                "interpolated": True,
            }
        )
    return words


def _flatten(segments: Sequence[Mapping[str, object]]) -> tuple[list[_Tok], int]:
    """All words across all segments, in order, with times sanitised.

    ``adjust_timestamps`` clamps every word into its own segment's window,
    so zero-duration and equal-timestamp words are routine rather than
    exceptional, and an unsanitised ``next.start - current.end`` can go
    negative and manufacture a spurious run break.  Nothing is reordered
    and nothing is dropped, so text is conserved.
    """
    tokens: list[_Tok] = []
    interpolated = 0

    for segment in segments:
        words = segment.get("words") or []
        if not words:
            words = interpolate_words(segment)
            if words:
                interpolated += 1
        segment_speaker = segment.get("speaker")
        for word in words:
            speaker = word.get("speaker", segment_speaker)
            token = _make_token(word, speaker if isinstance(speaker, int) else None)
            if token is not None:
                tokens.append(token)

    previous_end = 0.0
    for token in tokens:
        token.start = max(token.start, previous_end)
        token.end = max(token.end, token.start)
        previous_end = token.end
        # Write the sanitised values back so a cue's start can never
        # disagree with its own words[0].start in the JSON output.
        token.source["start"] = token.start
        token.source["end"] = token.end

    return tokens, interpolated


def build_runs(tokens: Sequence[_Tok], limits: Limits) -> list[list[_Tok]]:
    """Group tokens into stretches no cue may ever span.

    A new run starts when the speaker changes or the silence before a word
    exceeds ``run_gap``.  Joining same-speaker content across Whisper's own
    segment boundaries first is what stops a sentence being cut after
    "the" just because that is where a segment ended.
    """
    runs: list[list[_Tok]] = []
    for token in tokens:
        if runs:
            previous = runs[-1][-1]
            same_speaker = previous.speaker == token.speaker
            if same_speaker and token.start - previous.end <= limits.run_gap:
                runs[-1].append(token)
                continue
        runs.append([token])
    return runs


# --- choosing cue boundaries -------------------------------------------
#
# A forward dynamic program per run: cost[j] is the cheapest way to cover
# the run's first j tokens.  Predecessors are scanned downward from j-1
# and the scan breaks as soon as either the duration or the width bound is
# exceeded -- both are monotone in j-i -- so the window is a few dozen
# tokens whatever the run's length.
#
# There is a mandatory i = j-1 fallback, so the DP always terminates with
# a solution: one token per cue in the worst case.  (The greedy reference
# implementation has two potentially unbounded loops and a repair pass
# that exists only to fix up runts it created.)

COST_SENTENCE_END = -24.0
COST_COMMA_END = -14.0
COST_CLOSER_END = -8.0
COST_PAUSE = -10.0
COST_GOOD_START = -6.0
COST_BAD_END = 18.0
COST_NEVER_END = 60.0
COST_FILL = 25.0
COST_BALANCE = 0.12
COST_SECOND_LINE = 2.0
COST_ORPHAN_TOKENS = 30.0
COST_ORPHAN_WIDTH = 15.0
COST_SPEED = 2.0
COST_OVER_DURATION = 40.0
COST_OVER_DURATION_RATE = 20.0
COST_UNDER_DURATION = 10.0

_ORPHAN_TOKEN_COUNT = 2
_ORPHAN_WIDTH_RATIO = 0.3
_CLOSERS = frozenset("\"'”’）)]}」』")


@dataclass
class _Cue:
    tokens: list[_Tok]
    text: str
    start: float
    end: float
    speaker: Optional[int]
    columns: int
    lines: list[int]
    label: str = ""


def _cue_columns(tokens: Sequence[_Tok], start: int, stop: int) -> int:
    """Rendered width of ``tokens[start:stop]`` as a single line."""
    total = tokens[start].columns_head
    for index in range(start + 1, stop):
        total += tokens[index].columns_tail
    return total


def _plan_run(
    tokens: Sequence[_Tok],
    limits: Limits,
    prefix_columns: int,
) -> list[tuple[int, int, Optional[str]]]:
    """Choose cue boundaries inside one run.

    Returns ``(start, stop, wrapped_text_or_None)`` triples.  A ``None``
    wrap means no legal line break existed and the caller must record a
    width violation -- which only happens for a single token wider than
    the whole cue budget.
    """
    count = len(tokens)
    profile = limits.profile
    cost = [0.0] + [_INFINITY] * count
    back: list[int] = [0] * (count + 1)

    # Prefix sums so a span's width is O(1).  The DP evaluates tens of
    # spans per token, so an O(span) width would make this quadratic on a
    # long run -- an hour of speech is several thousand words.
    cumulative = [0] * (count + 1)
    for index, token in enumerate(tokens):
        cumulative[index + 1] = cumulative[index] + token.columns_tail

    def span_columns(start: int, stop: int) -> int:
        return tokens[start].columns_head + (cumulative[stop] - cumulative[start + 1])

    def span_text(start: int, stop: int) -> str:
        return "".join(token.text for token in tokens[start:stop]).strip()

    def evaluate(start: int, stop: int) -> float:
        own_prefix = prefix_columns if start == 0 else 0
        columns = span_columns(start, stop)

        penalty = 0.0
        if columns + own_prefix <= limits.line_columns:
            # Fits on one line; no need to join the text or wrap it.
            widths = [columns + own_prefix]
        else:
            wrapped = wrap_text(
                span_text(start, stop),
                max_columns=limits.line_columns,
                max_lines=limits.max_lines,
                prefix_columns=own_prefix,
                profile=profile,
            )
            if wrapped is None:
                # Only reachable for a lone token wider than one line.
                penalty += COST_FILL * 4
                widths = [columns + own_prefix]
            else:
                widths = [
                    text_columns(line) + (own_prefix if index == 0 else 0)
                    for index, line in enumerate(wrapped.split("\n"))
                ]
            penalty += COST_SECOND_LINE * (len(widths) - 1)
            if len(widths) > 1:
                penalty += COST_BALANCE * abs(widths[0] - max(widths[1:]))

        # Quadratic emptiness (Knuth-Plass badness): squared under-fill is
        # what produces evenly sized cues instead of one full cue followed
        # by a runt.  Packing full is the default; punctuation is the
        # override.
        used = min(columns + own_prefix, limits.cue_columns)
        penalty += COST_FILL * (1.0 - used / limits.cue_columns) ** 2

        duration = tokens[stop - 1].end - tokens[start].start
        if duration > limits.max_duration:
            penalty += COST_OVER_DURATION
            penalty += COST_OVER_DURATION_RATE * (duration - limits.max_duration)
        elif duration < limits.min_duration:
            penalty += COST_UNDER_DURATION

        # Evaluated pre-stretch: the timing pass may still rescue it, so
        # this must not be harsh enough to force an absurd split.
        if duration > 0:
            speed = columns / duration
            if speed > limits.columns_per_second:
                penalty += COST_SPEED * (speed - limits.columns_per_second) ** 2

        whole_run = start == 0 and stop == count
        if not whole_run:
            if stop - start <= _ORPHAN_TOKEN_COUNT:
                penalty += COST_ORPHAN_TOKENS
            if columns < limits.line_columns * _ORPHAN_WIDTH_RATIO:
                penalty += COST_ORPHAN_WIDTH

        # Quality of the boundary that FOLLOWS this cue.  The end of a run
        # is a free boundary.
        if stop < count:
            # The trailing punctuation and the last word both live in the
            # final token, so the span never needs joining for this.
            stripped = tokens[stop - 1].text.rstrip()
            if stripped:
                if stripped[-1] in profile.sentence_final:
                    penalty += COST_SENTENCE_END
                elif stripped[-1] in profile.comma_like:
                    penalty += COST_COMMA_END
                elif stripped[-1] in _CLOSERS:
                    penalty += COST_CLOSER_END
                tail = _last_word(stripped)
                if tail in profile.never_end:
                    penalty += COST_NEVER_END
                elif tail in profile.bad_end:
                    penalty += COST_BAD_END
            if _first_word(tokens[stop].text) in profile.good_start:
                penalty += COST_GOOD_START
            # A ramp, not a step: without it a 0.28 s pause cannot beat a
            # 0.02 s one, and the pause is the only signal available in
            # punctuation-free CJK.
            gap = max(0.0, tokens[stop].start - tokens[stop - 1].end)
            penalty += COST_PAUSE * min(1.0, gap / limits.pause_bonus_gap)

        return penalty

    for stop in range(1, count + 1):
        best = _INFINITY
        best_start = stop - 1
        for start in range(stop - 1, -1, -1):
            if start < stop - 1:
                # Both bounds are monotone in the span length, so once one
                # is exceeded every wider predecessor exceeds it too.
                duration = tokens[stop - 1].end - tokens[start].start
                if duration > limits.max_duration:
                    break
                if span_columns(start, stop) > limits.cue_columns:
                    break
            total = cost[start] + evaluate(start, stop)
            if total < best:
                best = total
                best_start = start
        cost[stop] = best
        back[stop] = best_start

    # Wrapping is only needed for the spans that actually won, so it is
    # deferred to here rather than done for every candidate.
    chosen: list[tuple[int, int]] = []
    stop = count
    while stop > 0:
        start = back[stop]
        chosen.append((start, stop))
        stop = start
    chosen.reverse()

    spans: list[tuple[int, int, Optional[str]]] = []
    for start, stop in chosen:
        own_prefix = prefix_columns if start == 0 else 0
        spans.append(
            (
                start,
                stop,
                wrap_text(
                    span_text(start, stop),
                    max_columns=limits.line_columns,
                    max_lines=limits.max_lines,
                    prefix_columns=own_prefix,
                    profile=profile,
                ),
            )
        )
    return spans


# --- timing -------------------------------------------------------------


def _adjust_timings(cues: list[_Cue], limits: Limits) -> tuple[int, int, int]:
    """One left-to-right sweep over cue end times.

    ``start`` is never moved: it is the first word's own start (spec 4.2),
    and because word times are monotone after sanitising, natural spans
    never overlap, so no cue can be pushed into its neighbour.

    ``end`` is only ever extended forward into the following silence, and
    is capped AFTER stretching so a reading-speed stretch cannot produce
    an eight-second cue.  A cue of a single word that is already longer
    than ``max_duration`` keeps its own span -- truncating it would hide a
    word.

    Returns ``(stretched, over_reading_speed, over_duration)``.
    """
    stretched = 0
    over_speed = 0
    over_duration = 0

    for index, cue in enumerate(cues):
        natural_end = cue.end
        following = cues[index + 1].start if index + 1 < len(cues) else None
        limit_end = (
            following - limits.min_gap
            if following is not None
            else natural_end + limits.max_duration
        )

        needed = cue.start + limits.min_duration
        if limits.columns_per_second > 0:
            needed = max(needed, cue.start + cue.columns / limits.columns_per_second)

        end = max(natural_end, min(needed, limit_end))
        if len(cue.tokens) > 1 or end - cue.start <= limits.max_duration:
            end = min(end, cue.start + limits.max_duration)
        cue.end = end

        if end > natural_end:
            stretched += 1
        duration = cue.end - cue.start
        if duration > limits.max_duration:
            over_duration += 1
        if duration > 0 and cue.columns / duration > limits.columns_per_second:
            over_speed += 1

    return stretched, over_speed, over_duration


# --- statistics ---------------------------------------------------------


@dataclass(frozen=True)
class SegmentationStats:
    cues_in: int = 0
    cues_out: int = 0
    runs: int = 0
    words_total: int = 0
    over_duration: int = 0
    over_lines: int = 0
    over_line_width: int = 0
    over_reading_speed: int = 0
    stretched: int = 0
    longest_duration: float = 0.0
    interpolated_segments: int = 0

    def log_message(self) -> str:
        """The spec 4.9 summary line.

        Lives here rather than in the transcriber because transcriber.py
        imports faster_whisper at module level and so cannot be imported
        by a CI test; this can.
        """
        return (
            f"subtitle segmentation: {self.cues_in} -> {self.cues_out} cues "
            f"in {self.runs} runs, {self.over_duration} over duration, "
            f"{self.over_lines} over line count, "
            f"{self.over_reading_speed} over reading speed, "
            f"{self.stretched} stretched, "
            f"longest {self.longest_duration:.2f}s"
        )


# --- the public entry points -------------------------------------------


def resegment(
    segments: Sequence[Mapping[str, object]],
    options: SegmentationOptions,
    *,
    language: Optional[str] = None,
    label_for: Optional[Callable[[Optional[int]], str]] = None,
) -> tuple[list[dict], SegmentationStats]:
    """Re-cut ``segments`` into subtitle-sized cues by word timestamps.

    Pure: neither the input segments nor their word dicts are mutated
    (apart from the sanitised times written onto the copies carried into
    the cues).

    ``label_for`` maps a speaker index to its display label.  When given,
    only the FIRST cue of each speaker stretch gets ``speaker_label`` --
    repeating ``[Speaker 1] `` on every one of several hundred cues costs
    a quarter of the first line's width each time.  Every cue still gets
    ``speaker``.  The label's width is charged to line 1, measured with
    ``writers.format_speaker_prefix`` so segmentation and the writer
    cannot disagree about it.
    """
    limits = resolve_limits(options, language)
    tokens, interpolated = _flatten(segments)
    if not tokens:
        return [], SegmentationStats(cues_in=len(segments), interpolated_segments=interpolated)

    runs = build_runs(tokens, limits)

    cues: list[_Cue] = []
    over_lines = 0
    over_width = 0
    previous_speaker: object = object()  # a sentinel no speaker can equal

    for run in runs:
        speaker = run[0].speaker
        # The speaker stretch is tracked across runs, so a three-second
        # pause by the same person does not re-label them.
        is_new_speaker = speaker != previous_speaker
        previous_speaker = speaker

        label = ""
        if label_for is not None and is_new_speaker and speaker is not None:
            label = label_for(speaker)
        prefix_columns = text_columns(format_speaker_prefix(label)) if label else 0

        spans = _plan_run(run, limits, prefix_columns)
        for order, (start, stop, wrapped) in enumerate(spans):
            raw = "".join(token.text for token in run[start:stop]).strip()
            if not raw:
                # A blank cue would be numbered differently by the Python
                # and JS SRT writers; never emit one.
                continue
            text = wrapped if wrapped is not None else raw
            widths = [
                text_columns(line) + (prefix_columns if order == 0 and i == 0 else 0)
                for i, line in enumerate(text.split("\n"))
            ]
            if len(widths) > limits.max_lines:
                over_lines += 1
            if any(width > limits.line_columns for width in widths):
                over_width += 1
            cues.append(
                _Cue(
                    tokens=list(run[start:stop]),
                    text=text,
                    start=run[start].start,
                    end=run[stop - 1].end,
                    speaker=speaker,
                    columns=_cue_columns(run, start, stop),
                    lines=widths,
                )
            )
            if order == 0 and label:
                cues[-1].label = label

    stretched, over_speed, over_duration = _adjust_timings(cues, limits)

    out: list[dict] = []
    for cue in cues:
        # An explicit whitelist, never {**segment}: spreading the source
        # segment drags stray keys (expand_amount) onto every cue, where
        # they are meaningless or actively wrong for a cue that spans two
        # segments.
        entry: dict = {
            "start": cue.start,
            "end": cue.end,
            "text": cue.text,
            "words": [token.source for token in cue.tokens],
        }
        if cue.speaker is not None:
            entry["speaker"] = cue.speaker
        if cue.label:
            entry["speaker_label"] = cue.label
        out.append(entry)

    stats = SegmentationStats(
        cues_in=len(segments),
        cues_out=len(out),
        runs=len(runs),
        words_total=len(tokens),
        over_duration=over_duration,
        over_lines=over_lines,
        over_line_width=over_width,
        over_reading_speed=over_speed,
        stretched=stretched,
        longest_duration=max((cue.end - cue.start for cue in cues), default=0.0),
        interpolated_segments=interpolated,
    )
    return out, stats


def apply_to_result(
    result: dict,
    options: SegmentationOptions,
    *,
    language: Optional[str] = None,
    label_for: Optional[Callable[[Optional[int]], str]] = None,
) -> SegmentationStats:
    """Transcriber-facing wrapper.

    Replaces ``result["segments"]`` with the cues, refreshes
    ``result["text"]`` from them, and records the parameters actually used
    in ``result["segmentation"]`` so a later release can tell whether
    re-segmenting on save would be safe.
    """
    limits = resolve_limits(options, language)
    cues, stats = resegment(
        result.get("segments") or [], options, language=language, label_for=label_for
    )
    result["segments"] = cues
    # "".join is the one join correct for both conventions: faster-whisper
    # carries the separator inside each Latin word and omits it for CJK.
    result["text"] = "".join(
        str(word.get("word", "")) for cue in cues for word in cue.get("words", [])
    ).strip()
    result["segmentation"] = {
        "version": 1,
        "language": limits.profile.code or "",
        "profile": "cjk" if limits.profile.cjk else "latin",
        "max_line_chars": limits.line_chars,
        "line_columns": limits.line_columns,
        "max_lines": limits.max_lines,
        "max_duration": limits.max_duration,
        "min_duration": limits.min_duration,
        "min_gap": limits.min_gap,
        "run_gap": limits.run_gap,
        "reading_speed_columns_per_second": limits.columns_per_second,
        "stats": asdict(stats),
    }
    if stats.interpolated_segments and stats.interpolated_segments == stats.cues_in:
        _log.warning(
            "subtitle segmentation ran without word timestamps on all %d segments; "
            "cue times are estimated from character positions",
            stats.interpolated_segments,
        )
    return stats
