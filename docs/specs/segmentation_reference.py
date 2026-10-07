"""REFERENCE ONLY (2026-10-07): subtitle re-segmentation heuristics.

Not imported by the app.  This script re-segments an already-written VTT
file WITHOUT word timestamps, so cue times are interpolated from the original
cue timestamps by character position.  The real feature must work on Whisper
word timestamps (see docs/specs/subtitle-segmentation.md), where no
interpolation is needed.  Reuse or improve the heuristics:

- runs: consecutive cues of the same speaker with gaps <= 1 s are joined
  first, so sentences Whisper cut across segments can be re-split cleanly
- split preference: sentence-final punctuation > comma-like punctuation >
  before a conjunction/preposition (GOOD_START); avoid ending a line with
  an article/preposition/possessive (BAD_END)
- line wrap: two lines, as equal as possible, with punctuation/phrase bonus
- "few characters over a long span" (< 8 chars/s) means silence or
  applause: do not split, cap the cue at 7 s instead
- too-short cues are merged with a same-speaker neighbour when the result
  still fits, otherwise stretched into the following gap (never overlapping)

Validated on the 2026-10-07 seminar transcript: 408 -> 727 cues, 0 cues over
7 s, 0 cues over 2 lines, no line over 42 chars, no overlaps, and the word
sequence (7011 words) is identical before and after.

Usage: python3 segmentation_reference.py <in.vtt> <out.vtt>
"""

import math
import re
import sys
import unicodedata

MAX_LINE = 42
MAX_CUE = MAX_LINE * 2
MAX_DUR = 7.0
MIN_DUR = 5 / 6
GAP_BREAK = 1.0
LABEL_RE = re.compile(r"^(【[^】]+】)")
CONJ = (" and ", " but ", " so ", " because ", " which ", " then ", " if ", " that ", " or ")


def width(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def to_sec(ts: str) -> float:
    p = ts.split(":")
    return (int(p[0]) * 3600 if len(p) == 3 else 0) + int(p[-2]) * 60 + float(p[-1])


def to_ts(sec: float) -> str:
    ms = round(sec * 1000)
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return (f"{h:02d}:" if h else "") + f"{m:02d}:{s:02d}.{ms:03d}"


# ---------------------------------------------------------------- text splitting

GOOD_START = {"and", "but", "so", "because", "which", "then", "if", "that", "or", "when",
              "where", "while", "to", "in", "on", "at", "for", "with", "from", "of",
              "near", "inside", "around", "into", "within", "like", "using", "based"}
BAD_END = {"the", "a", "an", "of", "to", "in", "on", "at", "for", "with", "from", "near",
           "by", "into", "my", "your", "our", "their", "this", "these", "those"}


def split_score(left: str, right: str, prefix_w: int = 0) -> float:
    score = abs(width(left) + prefix_w - width(right))
    if re.search(r"[.?!]$", left):
        score -= 16
    elif re.search(r"[,;:]$", left):
        score -= 10
    if right.split(" ")[0].lower() in GOOD_START:
        score -= 6
    if left.split(" ")[-1].lower().strip(",.") in BAD_END:
        score += 14
    return score


def split_score_cue(left: str, right: str) -> float:
    total = width(left) + width(right)
    short_side = min(width(left), width(right))
    score = 0.15 * abs(width(left) - width(right)) + 2 * max(0.0, 0.3 * total - short_side)
    if re.search(r"[.?!]$", left):
        score -= 16
    elif re.search(r"[,;:]$", left):
        score -= 10
    if right.split(" ")[0].lower() in GOOD_START:
        score -= 8
    if left.split(" ")[-1].lower().strip(",.") in BAD_END:
        score += 14
    return score


def best_two_split(text: str, max_left: int, max_right: int, prefix_w: int = 0, cue: bool = False):
    words = text.split(" ")
    best = None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        if width(a) + prefix_w <= max_left and width(b) <= max_right:
            sc = split_score_cue(a, b) if cue else split_score(a, b, prefix_w)
            if best is None or sc < best[0]:
                best = (sc, a, b)
    return (best[1], best[2]) if best else None

def balanced_words(text: str, n: int) -> list[str]:
    words = text.split(" ")
    if n <= 1 or len(words) <= 1:
        return [text]
    target = width(text) / n
    chunks, cur = [], ""
    for w in words:
        cand = f"{cur} {w}".strip()
        if cur and width(cur) >= target and len(chunks) < n - 1:
            chunks.append(cur)
            cur = w
        else:
            cur = cand
    chunks.append(cur)
    return chunks


def split_long(text: str, limit: int) -> list[str]:
    """Split one sentence that is longer than limit."""
    parts = re.split(r"(?<=[,;:]) ", text)
    if len(parts) > 1:
        packed = pack(parts, limit, allow_recurse=False)
        if all(width(p) <= limit for p in packed):
            return packed
    best = None
    for conj in CONJ:
        for m in re.finditer(re.escape(conj), text):
            left, right = text[: m.start()], text[m.start() + 1:]
            if left and right and width(left) <= limit:
                score = abs(width(left) - width(right))
                if best is None or score < best[0]:
                    best = (score, left, right)
    if best and best[0] < width(text) * 0.5:
        _, left, right = best
        return [left] + (split_long(right, limit) if width(right) > limit else [right])
    n = math.ceil(width(text) / limit)
    if n == 2:
        pair = best_two_split(text, limit, limit, cue=True)
        if pair:
            return list(pair)
    while True:
        chunks = balanced_words(text, n)
        if all(width(c) <= limit for c in chunks) or n > 60:
            return chunks
        n += 1


def pack(units: list[str], limit: int, allow_recurse: bool = True) -> list[str]:
    chunks, cur = [], ""
    for u in units:
        if width(u) > limit and allow_recurse:
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.extend(split_long(u, limit))
            continue
        cand = f"{cur} {u}".strip()
        if cur and width(cand) > limit:
            chunks.append(cur)
            cur = u
        else:
            cur = cand
    if cur:
        chunks.append(cur)
    return chunks


def wrap_two_lines(text: str, prefix_w: int) -> str | None:
    if width(text) + prefix_w <= MAX_LINE:
        return text
    pair = best_two_split(text, MAX_LINE, MAX_LINE, prefix_w)
    return f"{pair[0]}\n{pair[1]}" if pair else None


# ---------------------------------------------------------------- runs & timing

class Run:
    def __init__(self, label: str):
        self.label = label
        self.cues: list[tuple[float, float, str]] = []

    def text(self) -> str:
        return " ".join(t for _, _, t in self.cues)

    def anchors(self):
        pos, out = 0, []
        for t0, t1, t in self.cues:
            out.append((pos, pos + len(t), t0, t1))
            pos += len(t) + 1
        return out

    def time_at(self, pos: int, is_end: bool) -> float:
        anchors = self.anchors()
        for c0, c1, t0, t1 in anchors:
            inside = (c0 < pos <= c1) if is_end else (c0 <= pos < c1)
            if inside:
                return t0 + (t1 - t0) * (pos - c0) / max(c1 - c0, 1)
        # position on a joining space: snap to neighbouring cue boundary
        for c0, c1, t0, t1 in anchors:
            if pos <= c0:
                return t0
        return anchors[-1][3]


def chunk_run(run: Run) -> list[tuple[float, float, str, str]]:
    text = run.text()
    label_w = width(run.label)
    sentences = re.split(r"(?<=[.?!]) (?=\S)", text)
    chunks = pack(sentences, MAX_CUE)

    # label must fit together with the first chunk
    if run.label and width(chunks[0]) + label_w > MAX_CUE:
        chunks = split_long(chunks[0], MAX_CUE - label_w) + chunks[1:]

    def offsets(chs):
        pos, out = 0, []
        for c in chs:
            out.append((pos, pos + len(c)))
            pos += len(c) + 1
        return out

    # enforce two-line wrapping and max duration by further splitting
    changed = True
    while changed:
        changed = False
        new = []
        for i, (c, (s, e)) in enumerate(zip(chunks, offsets(chunks))):
            prefix_w = label_w if (i == 0 and not new) else 0
            dur = run.time_at(e, True) - run.time_at(s, False)
            too_wide = wrap_two_lines(c, prefix_w) is None
            too_long = dur > MAX_DUR and len(c) / dur >= 8  # slow text over a long span = silence; cap later
            if too_wide or too_long:
                pair = best_two_split(c, MAX_CUE - prefix_w, MAX_CUE, cue=too_long and not too_wide)
                new.extend(pair if pair else balanced_words(c, 2))
                changed = True
            else:
                new.append(c)
        chunks = new

    # merge chunks that would flash by too quickly
    i = 0
    while i < len(chunks):
        offs = offsets(chunks)
        s, e = offs[i]
        dur = run.time_at(e, True) - run.time_at(s, False)
        if dur < MIN_DUR and len(chunks) > 1:
            j = i - 1 if i > 0 else i + 1
            a, b = sorted((i, j))
            joined = f"{chunks[a]} {chunks[b]}"
            js, je = offs[a][0], offs[b][1]
            jdur = run.time_at(je, True) - run.time_at(js, False)
            prefix_w = label_w if a == 0 else 0
            if jdur <= MAX_DUR and wrap_two_lines(joined, prefix_w) is not None:
                chunks[a:b + 1] = [joined]
                continue
        i += 1

    out = []
    for i, (c, (s, e)) in enumerate(zip(chunks, offsets(chunks))):
        t0, t1 = run.time_at(s, False), run.time_at(e, True)
        if t1 - t0 > MAX_DUR:  # short text followed by silence/applause
            t1 = t0 + MAX_DUR
        prefix = run.label if i == 0 else ""
        out.append((t0, t1, prefix, wrap_two_lines(c, width(prefix)) or c))
    return out


def main(src: str, dst: str) -> None:
    raw = open(src, encoding="utf-8").read()
    blocks = [b for b in raw.split("\n\n") if "-->" in b]
    runs: list[Run] = []
    prev_end = None
    for b in blocks:
        head, *body = b.strip().split("\n")
        a, _, z = head.partition(" --> ")
        t0, t1 = to_sec(a), to_sec(z)
        text = " ".join(" ".join(body).split())
        m = LABEL_RE.match(text)
        label = m.group(1) if m else ""
        text = text[len(label):].strip()
        if label or not runs or (prev_end is not None and t0 - prev_end > GAP_BREAK):
            runs.append(Run(label))
        runs[-1].cues.append((t0, t1, text))
        prev_end = t1

    lines = ["WEBVTT", "", "NOTE",
             "Re-segmented to subtitle norms: max 42 chars/line, max 2 lines, max 7 s per cue",
             "Cue times are interpolated from the original timestamps by character position", ""]
    cues = [c for run in runs for c in chunk_run(run)]
    for i, (t0, t1, prefix, body) in enumerate(cues):
        if t1 - t0 < MIN_DUR:
            nxt = cues[i + 1][0] if i + 1 < len(cues) else t0 + MIN_DUR
            cues[i] = (t0, max(t1, min(t0 + MIN_DUR, nxt)), prefix, body)
    n = 0
    for t0, t1, prefix, body in cues:
        lines += [f"{to_ts(t0)} --> {to_ts(t1)}", f"{prefix}{body}", ""]
        n += 1
    open(dst, "w", encoding="utf-8").write("\n".join(lines))
    print(f"input cues={len(blocks)} runs={len(runs)} output cues={n}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
