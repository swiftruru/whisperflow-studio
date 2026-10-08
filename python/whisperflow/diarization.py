# New module (no upstream counterpart).
# Speaker diarization ("who spoke when") on top of sherpa-onnx, which runs
# the pyannote segmentation-3.0 model plus a speaker-embedding model on
# ONNX Runtime -- no torch, no Hugging Face token, and wheels for every
# platform the app ships on.  See docs/specs/speaker-diarization.md.
#
# Pipeline position: after Transcriber._run_vad (Whisper segments are
# already on the global timeline) and before _write_outputs.
#
# Everything above SherpaDiarizer is pure Python and unit-tested on CI,
# which installs only pytest/ffmpeg-python/numpy.  That is why
# ``import sherpa_onnx`` is deferred into _import_sherpa_onnx().

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Optional, Sequence

_log = logging.getLogger(__name__)

# sherpa-onnx wants 16 kHz mono float32, which is exactly what
# vad.base.load_audio() produces.
SAMPLE_RATE = 16_000

DEFAULT_SPEAKER_LABEL_TEMPLATE = "Speaker {n}"

# Beyond ~4 threads ONNX Runtime's intra-op scaling is sub-linear for a
# 6 MB + 28 MB model pair, and the CTranslate2 Whisper model is still
# resident in GLOBAL_MODEL_CACHE while this runs -- so a dual-core machine
# must not be oversubscribed.
_MAX_THREADS = 4

# sherpa-onnx defaults, pinned here so the values are visible next to the
# code that depends on them.
_MIN_DURATION_ON = 0.3
_MIN_DURATION_OFF = 0.5


# --- repairing over-clustering on long recordings ------------------------
#
# sherpa-onnx clusters with complete linkage on cosine distance, hard-coded
# (csrc/fast-clustering.cc), and offers no size guard: FastClusteringConfig
# is only (num_clusters, threshold, compute_confidence).  Complete linkage
# merges two clusters only when their WORST pair is within the threshold, so
# one outlier embedding inside a cluster permanently vetoes every further
# merge -- and the outlier population grows with recording length, because
# the C++ side admits an embedding from as little as 0.169 s of speech.
#
# Measured on a 64-minute talk with roughly four speakers: 443 turns came
# back as 60 "speakers", of which 19 held under a second of speech each and
# 0.4% of the total between them.  The dominant speaker was the worst case --
# the final repair folds 25 of those raw clusters back into him, 10 of which
# held more than the debris floor, and their duration-weighted centroids span
# cosine 0.745 to 0.978.  (It was 33 before unembeddable turns began going to
# their temporal neighbour rather than to the largest cluster: 8 of them
# belonged elsewhere in time.)  That spread is why the merge threshold has to sit
# near 0.6 rather than near upstream's 0.8.  Raising sherpa's own threshold
# does not fix any of it -- 0.5 gives 60 speakers, 0.8 still gives 17 --
# because that threshold is a per-segment comparison and the debris sits
# outside it.
#
# Both of sherpa-onnx's own upstreams repair this afterwards, and neither
# re-clusters.  3D-Speaker, who train the CAM++ model we use, run
# ``cluster -> filter_minor_cluster -> merge_by_cos`` in
# speakerlab/process/cluster.py::CommonClustering.__call__; pyannote.audio
# absorbs small clusters into the nearest large centroid in
# pipelines/clustering.py.
#
# refine_labels() takes 3D-Speaker's two repair STAGES but runs them in the
# OPPOSITE order -- merge first, then the size filter.  That is deliberate
# and it is the one place this code knowingly departs from upstream: their
# filter counts fixed-length sub-segments from a dense sliding window, so a
# real speaker always has many of them, while ours counts seconds inside
# whole turns, where one speaker can hold very few.  Filtering first against
# sherpa's raw clusters therefore erases a speaker whose every fragment is
# sub-floor even when their total is well above it -- measured below.
#
# One deliberate departure from BOTH upstreams: when no cluster clears the
# floor, 3D-Speaker returns ``np.zeros_like(labels)`` and pyannote sets
# ``clusters[:] = 0`` -- each fusing every speaker into one.  We leave such
# clusters alone instead, because fusing speakers is precisely the erasure
# this function must not cause.
#
# Re-clustering the per-turn embeddings instead was tried and is WORSE: it
# hands them back to the same complete-linkage implementation, and on a
# 61-minute file it took 26 speakers to 29 while dropping cross-run
# consistency from 0.82 to 0.79.

# A CAM++ embedding needs a usable amount of speech behind it: embeddings
# from sub-second audio sit measurably further from their own speaker's
# centroid (median cosine about 0.35 below 0.5 s, against 0.9+ above a few
# seconds), so a turn shorter than this keeps its label but casts no vote in
# the centroid it would otherwise poison.  sherpa's own ``extractor.is_ready(stream)`` cannot
# serve as the guard -- it returns True for 0.05 s of audio -- so the gate is
# on duration.
#
# The gate IS load-bearing, measured with real embeddings for every turn
# (an earlier note here claimed it was inert; that was an artifact of a cache
# which had no embeddings below the gate at all).  Sweeping it on the
# 64-minute talk: 0.0-0.3 gives 5 speakers, 0.5-1.0 gives 4, 1.5 gives 5,
# 2.0 gives 8.  So both directions cost accuracy and 0.7 sits inside the
# correct band.
#
# Why sub-second embeddings are worth excluding, on the same file: pairs of
# such turns from the SAME sherpa cluster reach a median cosine of 0.292
# (7.6% reach the 0.62 merge threshold), pairs from different clusters 0.234
# -- barely distinguishable -- and the speaker centroid such a turn resembles
# most is its own cluster's only 9.9% of the time.  They are close to noise,
# and what they would poison is the one thing this module relies on.
MIN_EMBED_SECONDS = 0.7

# Long turns are embedded from their CENTRE, not their tail: a hand-over at
# the end of a turn would otherwise contaminate the embedding.
MAX_EMBED_SECONDS = 8.0

# A cluster holding less than this much speech is debris, not a speaker, and
# its turns are absorbed into the nearest surviving centroid.
#
# Measured in SECONDS rather than in number of turns, because a turn has no
# fixed length here: counting turns would treat one 60-second turn as less
# evidence than three 0.4-second ones.  pyannote does count embeddings
# (min_cluster_size, a tuned Integer(1, 20)) but its embeddings come from a
# fixed-length sliding window, and it still rescales the count for short
# files -- ``min(self.min_cluster_size, max(1, round(0.1 * num_embeddings)))``
# in pipelines/clustering.py.  Seconds need no such rescaling.
#
# Upstream's equivalent, derived carefully: 3D-Speaker's filter_minor_cluster
# drops a cluster when ``csize <= min_cluster_size``, and it ships
# min_cluster_size=4 against 1.5 s sub-segments at 0.75 s shift -- so its
# smallest SURVIVING cluster has 5 sub-segments, spanning 4.5 s if they are
# contiguous and up to 7.5 s if they are not.  Upstream's floor is therefore
# "at least 4.5 s", not the 3.75 s a naive conversion gives.
#
# Swept on the two calibration recordings at merge_cosine=0.62: both give
# their known answer for any floor in [2.50, 5.50].  Below that the
# 64-minute talk over-counts (5 at 2.25, 7 at 1.5); above it sherpa's 57 s
# sample loses speakers whose own turns are only 5.7-11.3 s (3 at 5.75, 2 at
# 6.0).  Upstream's 4.5 s also sits inside the window.
#
# 3.0 and NOT the centre of that window, deliberately.  Centring is the
# right instinct only when both failures cost the same, and here they do
# not: over-counting is visible and the user can pin a count to fix it,
# while erasure is silent -- the lines simply carry someone else's name.
# Inside the window every value scores identically on both calibration
# files, so the tie is broken by which cliff is worse to approach, and that
# is the upper one.  Measured cost of getting this wrong: at 4.0, four real
# speakers from sherpa's own sample holding 11.3 / 5.9 / 5.7 / 3.4 s come
# back as 3, and a chair plus three panellists introducing themselves in
# 3.9 s each come back as 1.  At 3.0 both stay whole.
MINOR_CLUSTER_SECONDS = 3.0

# Two clusters whose duration-weighted centroids agree at least this much are
# one speaker.  CALIBRATED HERE, not taken from upstream.
#
# 3D-Speaker ships mer_cos=0.8, and it does not transfer: theirs is tuned on
# centroids of dense 1.5 s windows at 0.75 s shift, whose averages are far
# less noisy than one embedding per turn.  On this project's own audio the
# dominant speaker's OWN sub-cluster centroids already span cosine
# 0.745-0.978, so a 0.80 cut leaves him split -- measured, it gives 10
# speakers on the 64-minute talk rather than 4.
#
# Swept on two recordings whose answers are known, over the per-turn
# embeddings this module actually produces, at MINOR_CLUSTER_SECONDS = 3.0:
#
#   64-minute talk (sherpa raw: 60 speakers, truly about 4)
#     <=0.53 -> 2    0.54-0.58 -> 3    0.59-0.65 -> 4    0.66-0.67 -> 5
#     0.68-0.72 -> 6    0.80 -> 10
#   sherpa's own 57 s 4-speaker sample (0-four-speakers-zh.wav)
#     <0.50 -> 3 (two real speakers fused)    >=0.50 -> 4
#
# Both are right for 0.59-0.65, and 0.62 sits inside it, a little above the
# midpoint on purpose: the low cliff fuses two real speakers while the high
# one merely reports an extra, and fusing is the worse failure.  The test
# beside this asserts the narrower 0.59-0.64, which is where the window sat
# before the two stages were iterated -- a deliberately conservative bound,
# since 0.65 now works only BECAUSE of the second pass.
#
# The window is NARROW and the margin should be known: after refinement the
# closest surviving pair on the 64-minute talk sits at cosine 0.5865.
# Anything that moves a single centroid by ~0.03 -- a different
# MAX_EMBED_SECONDS window, a thread count that changes ONNX reduction
# order, a re-encoded source -- can change the reported speaker count.  Not
# one of the 443 turns changes label between 0.60 and 0.62, so the move was
# margin, not behaviour; treat any further change as behaviour and re-run
# the sweep.
MERGE_COSINE = 0.62


class DiarizationDependencyError(RuntimeError):
    """``sherpa-onnx`` is missing from the bundled virtual environment.

    Carries a stable ``reason`` so bridge/run_cli.py can translate it into
    an error code the Electron side recognises.  (run_cli.py's catch-all
    reports ``type(err).__name__``, which no mapper matches, so every new
    failure mode needs an explicit ``except``.)
    """

    reason = "diarization_dependency_missing"

    def __init__(self, cause: Optional[BaseException] = None) -> None:
        super().__init__(
            "speaker diarization requires the sherpa-onnx package, which is "
            "not installed in this environment. Update the bundled Python "
            "environment from the System Check panel to install it."
        )
        self.cause = cause


@dataclass(frozen=True)
class SpeakerTurn:
    """One contiguous stretch of a single speaker, in seconds.

    ``speaker`` is 0-based and numbered by order of first appearance, not
    by sherpa-onnx's raw cluster id.  See renumber_turns().
    """

    start: float
    end: float
    speaker: int


def default_num_threads() -> int:
    """Threads for both sherpa-onnx models.  See ``_MAX_THREADS``."""
    return max(1, min(_MAX_THREADS, os.cpu_count() or 1))


def to_sherpa_num_clusters(num_speakers: object) -> int:
    """Map the config's speaker count onto sherpa-onnx's ``num_clusters``.

    ``0`` -- which is also what a blank Settings field coerces to -- means
    "decide automatically", and sherpa-onnx spells that ``-1``.  Passing 0
    straight through would be read as a literal cluster count of zero.
    """
    try:
        count = int(num_speakers)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return -1
    return count if count > 0 else -1


def resolve_label_template(template: object) -> str:
    """Return a label template guaranteed to format, warning once if not.

    A typo in the user's template should cost them the label they asked
    for, not the whole transcription -- so this is resolved once, up front,
    rather than failing per segment.
    """
    candidate = template if isinstance(template, str) and template.strip() else None
    if candidate is None:
        return DEFAULT_SPEAKER_LABEL_TEMPLATE
    try:
        candidate.format(n=1)
    except (KeyError, IndexError, ValueError) as err:
        _log.warning(
            "ignoring invalid speaker_label_template %r (%s); using %r instead",
            candidate,
            err,
            DEFAULT_SPEAKER_LABEL_TEMPLATE,
        )
        return DEFAULT_SPEAKER_LABEL_TEMPLATE
    return candidate


def speaker_label(
    speaker: Optional[int],
    template: str = DEFAULT_SPEAKER_LABEL_TEMPLATE,
) -> str:
    """0-based speaker index -> human label ("Speaker 1", "講者 1", ...).

    ``{n}`` is 1-based.  Callers that run this in a loop should pass a
    template already vetted by resolve_label_template(); the fallback here
    is a safety net, not the primary guard.
    """
    if speaker is None:
        return ""
    number = int(speaker) + 1
    try:
        return resolve_label_template(template).format(n=number)
    except (KeyError, IndexError, ValueError):
        return DEFAULT_SPEAKER_LABEL_TEMPLATE.format(n=number)


# A sentinel no speaker value can equal, so the first segment always
# counts as a change.  ``None`` will not do: an unlabelled segment has
# ``speaker is None``.
_NO_SPEAKER = object()


def label_speaker_turns(
    segments: Sequence[dict],
    template: str = DEFAULT_SPEAKER_LABEL_TEMPLATE,
) -> int:
    """Set ``speaker_label`` on the first segment of each speaker turn.

    A speaker talks across many Whisper segments, and ``"[Speaker 1] "``
    is a quarter of a 42-character subtitle line, so repeating it on every
    one of them is noise rather than information.  Mutates ``segments`` in
    place and returns how many labels were written.

    The key is left absent rather than set to ``""`` on the segments in
    between, which is what makes both writers and both chips skip them:
    ``format_speaker_prefix`` and ``transcript-reader.js`` treat a missing
    label and a blank one identically.

    ``text`` is never touched.  The label is a presentation string, so the
    JSON output carries no speaker markup and nothing downstream has to
    parse one back out of a subtitle line.
    """
    previous: object = _NO_SPEAKER
    written = 0
    for segment in segments:
        speaker = segment.get("speaker")
        if speaker != previous:
            label = speaker_label(speaker, template)
            if label:
                segment["speaker_label"] = label
                written += 1
        previous = speaker
    return written


def refine_labels(
    labels: Sequence[int],
    embeddings,
    usable: Sequence[bool],
    durations: Sequence[float],
    *,
    minor_seconds: float = MINOR_CLUSTER_SECONDS,
    merge_cosine: float = MERGE_COSINE,
) -> list[int]:
    """Repair over-clustering, in 3D-Speaker's order, on existing labels.

    ``embeddings`` is an (n, dim) float array of L2-normalised per-turn
    embeddings; ``usable[i]`` says whether row *i* is one (a turn too short
    to embed keeps its label but casts no vote).  ``durations[i]`` is the
    turn's full length in seconds, and both stages weigh by it -- see
    MINOR_CLUSTER_SECONDS for why the unit is seconds and not turns.

    A pinned speaker count is NOT a parameter here: _refine skips this
    function altogether in that case, because sherpa's cut-at-k already
    returns at most the pinned number and there would be nothing left to
    repair.

    Returns new labels, renumbered 0..N-1 by order of first appearance --
    the same convention as renumber_turns(), so a refined result is
    indistinguishable in form from an unrefined one.  No turn is ever
    dropped, so this cannot lose a cue's speaker: both stages only relabel.
    """
    import numpy as np

    n = len(labels)
    if n == 0:
        return []
    # np.array, not np.asarray: asarray hands back the SAME object for an
    # int64 input, and both stages write into it -- so a caller holding its
    # labels in an array would have them silently rewritten, which the
    # docstring's "returns new labels" promises not to happen.
    ids = np.array(labels, dtype=np.int64)
    dur = np.asarray(durations, dtype=np.float64)
    ok = np.asarray(usable, dtype=bool)
    emb = np.asarray(embeddings, dtype=np.float64).reshape(n, -1)

    groups: dict[int, "np.ndarray"] = {
        int(s): np.flatnonzero(ids == s) for s in np.unique(ids)
    }
    # Duration-weighted sum of the usable rows.  Kept unnormalised so a
    # merge is an addition rather than a recomputation -- which is what makes
    # the merge loop O(G^2) instead of O(G^3).
    total = {s: float(dur[m].sum()) for s, m in groups.items()}
    vector = {
        s: (emb[m] * (dur[m] * ok[m])[:, None]).sum(axis=0)
        for s, m in groups.items()
    }

    def unit(s):
        # np.isfinite as well as > 0: an inf component makes the norm inf,
        # inf/inf is NaN, and a NaN centroid is poison -- `NaN < threshold`
        # is False, so the merge is taken unconditionally and repeats until
        # one cluster is left.  Three mutually orthogonal speakers collapsed
        # into one, reported as success.  A cluster with no usable centroid
        # simply does not take part in merging.
        # The norm alone settles it: any inf component makes the norm inf and
        # any NaN component makes it NaN, so a finite positive norm proves
        # every component is finite.  No second check on the quotient.
        norm = float(np.linalg.norm(vector[s]))
        if not np.isfinite(norm) or norm <= 0:
            return None
        return vector[s] / norm

    def rebuild() -> None:
        nonlocal groups, total, vector
        groups = {int(s): np.flatnonzero(ids == s) for s in np.unique(ids)}
        total = {s: float(dur[m].sum()) for s, m in groups.items()}
        vector = {
            s: (emb[m] * (dur[m] * ok[m])[:, None]).sum(axis=0)
            for s, m in groups.items()
        }

    def merge_closest_pair() -> bool:
        """Merge the most similar pair of centroids.  True if it merged."""
        if len(groups) < 2:
            return False
        live = [s for s in groups if unit(s) is not None]
        if len(live) < 2:
            return False
        matrix = np.stack([unit(s) for s in live])
        similarity = matrix @ matrix.T
        np.fill_diagonal(similarity, -2.0)
        a, b = divmod(int(np.argmax(similarity)), len(live))
        if float(similarity[a, b]) < merge_cosine:
            return False
        # Which of the pair keeps its id is unobservable: the merged group is
        # identical either way (the centroid is a sum, the speech total a
        # sum) and the final renumber discards raw ids anyway.
        keeper, absorbed = live[a], live[b]
        ids[groups[absorbed]] = keeper
        groups[keeper] = np.concatenate([groups[keeper], groups[absorbed]])
        vector[keeper] = vector[keeper] + vector[absorbed]
        total[keeper] += total[absorbed]
        for store in (groups, vector, total):
            store.pop(absorbed)
        return True

    def absorb_debris() -> bool:
        """Relabel sub-floor clusters into the nearest survivor.

        True if anything moved.  Absorbs only when there is somewhere to
        absorb INTO: if every cluster is below the floor -- a recording of
        nothing but short interjections -- the right answer is to leave them
        all alone, not to fuse them into one.
        """
        keep = [s for s in groups if total[s] >= minor_seconds]
        centres = {s: c for s in keep if (c := unit(s)) is not None}
        if not centres or len(keep) >= len(groups):
            return False
        # A turn with no usable embedding is placed by TIME, not by size.
        # Turns arrive in time order, so the nearest index with a centroid is
        # the nearest speaker in the recording -- and a sub-second "mm-hm"
        # between two of someone's turns is almost certainly theirs.
        #
        # The alternative, handing it to the largest cluster, was close to
        # guessing: measured on the 64-minute talk, an embedding from under
        # 0.7 s of audio matches its OWN sherpa cluster's centroid best only
        # 9.9% of the time, and same-cluster pairs of such turns reach a
        # median cosine of just 0.292 against a 0.62 merge threshold.  Those
        # embeddings carry almost no speaker identity, which is also why the
        # gate exists and why lowering it makes things worse, not better.
        placed = sorted(i for s in keep for i in groups[s] if ok[i])

        def nearest_by_time(index: int) -> int:
            if not placed:
                return max(centres, key=lambda s: total[s])
            best = min(placed, key=lambda j: (abs(j - index), j))
            return int(ids[best])

        for small in [s for s in groups if s not in keep]:
            for i in groups[small]:
                ids[i] = (
                    max(centres, key=lambda s: float(emb[i] @ centres[s]))
                    if ok[i]
                    else nearest_by_time(i)
                )
        rebuild()
        return True

    # Merge BEFORE applying the floor.  The order is the whole correctness
    # argument: the floor asks "does this cluster hold enough speech to be a
    # speaker?", and that question is only meaningful once the fragments of
    # one speaker have been put back together.  Fragmentation is the
    # pathology being repaired, so measuring the floor against sherpa's raw
    # clusters measures the symptom.
    #
    # Applying the floor first erased a speaker whose every fragment was
    # sub-floor even though their total was well above it: measured on real
    # CAM++ embeddings, a speaker with 4.53 s of speech (1.5x the floor)
    # split into 2.62 / 1.08 / 0.83 s fragments vanished entirely, every line
    # reattributed to the dominant speaker.  That is a worse failure than the
    # over-counting this function exists to fix -- a spurious extra speaker
    # is visible, a deleted one is not.
    #
    # Iterated to a fixed point, because absorption genuinely creates new
    # merge opportunities.  An earlier version ran one pass of each on the
    # reasoning that absorb_debris() puts every turn with the centroid it
    # already resembles most, so it could not pull that centroid toward a
    # third cluster.  That reasoning is wrong: what matters is the SHIFT, not
    # the ranking.  Two clusters can both sit below the threshold from a
    # third and still cross it once a debris turn is added, because the
    # merged centroid is a normalised sum and the normalisation moves it.
    #
    # Measured on the 64-minute talk at merge_cosine 0.65, one pass leaves
    # five speakers with the closest surviving pair at 0.6585 -- above the
    # threshold, but the merge stage had already finished.  A second pass
    # takes it to four.  The constructed case in the tests is the same shape
    # with the arithmetic shown.
    #
    # Each absorb_debris() that returns True strictly reduces the number of
    # groups, so the loop is bounded by the initial group count.
    for _ in range(len(groups) + 1):
        while merge_closest_pair():
            pass
        if not absorb_debris():
            break

    # Renumber by ORDER OF FIRST APPEARANCE, the one convention this module
    # has -- see SpeakerTurn's docstring and renumber_turns().  Refinement
    # decides WHICH turns share a speaker; it must not also redefine what the
    # numbers mean.  Numbering by talk time instead made a talk open with
    # "[Speaker 4]" and withheld "Speaker 1" until the presenter spoke, and
    # silently relabelled every turn of a file whose speaker count had not
    # even changed.
    remap: dict[int, int] = {}
    return [remap.setdefault(int(s), len(remap)) for s in ids]


def renumber_turns(raw: Iterable) -> list[SpeakerTurn]:
    """Normalise sherpa-onnx segments into 0..N-1 :class:`SpeakerTurn`s.

    sherpa-onnx returns raw cluster ids, and they are *not* contiguous:
    four speakers can come back as 0, 1, 2, 7.  Renumbering by order of
    first appearance is what makes speaker_label() produce
    "Speaker 1".."Speaker 4".

    Takes anything with ``.start`` / ``.end`` / ``.speaker``, which keeps
    it testable without sherpa-onnx installed.
    """
    mapping: dict[int, int] = {}
    turns: list[SpeakerTurn] = []
    for item in raw:
        cluster = int(item.speaker)
        speaker = mapping.setdefault(cluster, len(mapping))
        turns.append(SpeakerTurn(float(item.start), float(item.end), speaker))
    return turns


# --- merging speaker turns into Whisper segments -------------------------


def assign_speakers(
    segments: list[dict],
    turns: Sequence[SpeakerTurn],
    *,
    split_on_change: bool = True,
    min_run_words: int = 2,
) -> list[dict]:
    """Attach a ``speaker`` key to every Whisper segment.

    With word timestamps (``word_timestamps=True`` in faster-whisper) each
    word is assigned the speaker it overlaps most, tiny runs are smoothed
    away, and -- when ``split_on_change`` is set -- a segment spanning a
    speaker change is split into one segment per speaker.  Without words,
    the whole segment goes to the speaker with the largest time overlap.

    Input segments and their word dicts are never mutated; copies are
    returned.  With no turns the input list is returned unchanged, so
    nothing gains a ``speaker`` key.
    """
    if not turns:
        return segments

    # _speaker_for_span breaks out of its scan on the first turn starting
    # after the span, which is only correct for turns sorted by start time.
    # diarize_samples() guarantees that via sort_by_start_time(), but this
    # function is public and callers pass turns of their own.
    ordered = sorted(turns, key=lambda turn: (turn.start, turn.end))

    out: list[dict] = []
    for segment in segments:
        words = segment.get("words") or []

        if not words:
            speaker = _speaker_for_span(
                ordered, float(segment["start"]), float(segment["end"])
            )
            out.append({**segment, "speaker": speaker})
            continue

        labelled = [
            {
                **word,
                "speaker": _speaker_for_span(
                    ordered, float(word["start"]), float(word["end"])
                ),
            }
            for word in words
        ]
        _smooth(labelled, min_run_words)

        if not split_on_change:
            out.append({**segment, "words": labelled, "speaker": _majority(labelled)})
            continue

        out.extend(_split_by_speaker(segment, labelled))
    return out


def _speaker_for_span(turns: Sequence[SpeakerTurn], start: float, end: float) -> int:
    overlap: dict[int, float] = {}
    for turn in turns:
        if turn.end <= start:
            continue
        if turn.start >= end:
            break  # turns are sorted by start time
        overlap[turn.speaker] = (
            overlap.get(turn.speaker, 0.0) + min(end, turn.end) - max(start, turn.start)
        )
    if overlap:
        return max(overlap, key=overlap.__getitem__)
    # No overlap at all -- e.g. a word that falls inside a short pause.
    # Fall back to whichever turn is nearest in time.
    middle = (start + end) / 2
    return min(turns, key=lambda turn: _distance_to(turn, middle)).speaker


def _distance_to(turn: SpeakerTurn, moment: float) -> float:
    if turn.start <= moment <= turn.end:
        return 0.0
    return min(abs(turn.start - moment), abs(turn.end - moment))


def _smooth(words: list[dict], min_run_words: int) -> None:
    """Absorb tiny runs (boundary jitter) into the surrounding speaker.

    A run shorter than ``min_run_words`` with the *same* speaker on both
    sides is almost always a word mis-assigned at a turn boundary, so it
    gets folded in.  One with two *different* speakers around it is kept:
    that is a real hand-over.

    Two things this deliberately does not do:

    * It leaves short runs at either edge of the segment alone.  They have
      only one neighbour, so there is no "both sides agree" signal — and
      absorbing them inverts short segments wholesale.  Worked example,
      min_run_words=2 and one jittered word in the middle of three:
      ``[0, 1, 0]`` has *three* runs of length one, so absorbing edges
      turns it into ``[1, 0, 1]`` (or ``[1, 1, 1]``, depending on whether
      the run list is kept up to date) instead of ``[0, 0, 0]``.
      Alternating input is worse still.
    * It does not read stale speakers.  ``runs`` is rewritten as entries
      are absorbed, because reading the original list hands a later
      iteration its predecessor's pre-absorption speaker, which
      mis-resolves two adjacent short runs and manufactures a fresh island
      rather than removing one.
    """
    if min_run_words <= 1:
        return

    runs = _runs(words)
    for index, (start, stop, _speaker) in enumerate(runs):
        if stop - start >= min_run_words:
            continue
        if index == 0 or index + 1 >= len(runs):
            continue  # at a segment edge: only one neighbour, so leave it
        previous = runs[index - 1][2]
        following = runs[index + 1][2]
        if previous != following:
            continue  # a genuine hand-over between two speakers
        for word in words[start:stop]:
            word["speaker"] = previous
        runs[index] = (start, stop, previous)


def _runs(words: list[dict]) -> list[tuple[int, int, int]]:
    """Group consecutive same-speaker words into ``(start, stop, speaker)``."""
    runs: list[tuple[int, int, int]] = []
    start = 0
    for index in range(1, len(words) + 1):
        if index == len(words) or words[index]["speaker"] != words[start]["speaker"]:
            runs.append((start, index, words[start]["speaker"]))
            start = index
    return runs


def _split_by_speaker(segment: dict, words: list[dict]) -> list[dict]:
    pieces: list[dict] = []
    for start, stop, speaker in _runs(words):
        chunk = words[start:stop]
        text = "".join(str(word.get("word", "")) for word in chunk)
        if not text.strip():
            # A blank piece would become an empty cue, and the Python and
            # JS SRT writers number empty cues differently.
            continue
        pieces.append(
            {
                **segment,
                "start": float(chunk[0]["start"]),
                "end": float(chunk[-1]["end"]),
                "text": text,
                "words": chunk,
                "speaker": speaker,
            }
        )

    if not pieces:
        # Every run was blank: keep the segment whole rather than dropping
        # it out of the transcript entirely.
        return [{**segment, "words": words, "speaker": _majority(words)}]

    # The outer boundaries stay exactly where Whisper (plus the VAD offset)
    # put them; only the interior boundaries come from word timings.
    pieces[0]["start"] = float(segment["start"])
    pieces[-1]["end"] = float(segment["end"])
    return pieces


def _majority(words: list[dict]) -> int:
    """The speaker holding the most wall-clock time across ``words``."""
    weight: dict[int, float] = {}
    for word in words:
        duration = float(word["end"]) - float(word["start"])
        weight[word["speaker"]] = weight.get(word["speaker"], 0.0) + duration
    return max(weight, key=weight.__getitem__)


# --- progress ------------------------------------------------------------


class ProgressThrottle:
    """Map a 0..1 fraction onto a progress band, rate-limiting the emits.

    sherpa-onnx's callback fires once per chunk -- hundreds of times for a
    long file -- and each emit is a stdout write plus flush on the Python
    side and a re-render on the renderer side.  The 0.2 s floor mirrors
    ``SharedProgressState._EMIT_EVERY_SEC`` in models/progress_tqdm.py so
    both progress channels feel the same.

    Never walks the bar backwards, and always emits once the fraction
    reaches 1.0 so the band closes at its top.

    Not thread-safe: sherpa-onnx calls back on the calling thread.  Should
    that ever change, ``SharedProgressState`` is the lock-based template.
    """

    _EMIT_EVERY_SEC = 0.2
    _MIN_DELTA = 1.0

    def __init__(
        self,
        emit: Callable[[float], None],
        *,
        start: float,
        span: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._emit = emit
        self._start = float(start)
        self._span = float(span)
        self._clock = clock
        self._last_emit: Optional[float] = None
        self._last_value: Optional[float] = None

    def __call__(self, fraction: float) -> None:
        fraction = min(1.0, max(0.0, float(fraction)))
        value = self._start + self._span * fraction
        is_final = fraction >= 1.0

        if self._last_value is not None and value <= self._last_value:
            return

        if not is_final and self._last_emit is not None:
            if self._clock() - self._last_emit < self._EMIT_EVERY_SEC:
                return
            if self._last_value is not None and value - self._last_value < self._MIN_DELTA:
                return

        self._last_emit = self._clock()
        self._last_value = value
        self._emit(value)


# --- the engine ----------------------------------------------------------


def _import_sherpa_onnx():
    """Import sherpa-onnx, raising :class:`DiarizationDependencyError`.

    Deliberately not a module-level import: this module has to import
    cleanly on a machine without sherpa-onnx so the pure functions above
    can be unit-tested (CI installs only pytest, ffmpeg-python and numpy).
    """
    try:
        import sherpa_onnx
    except ImportError as err:  # pragma: no cover - needs sherpa absent
        raise DiarizationDependencyError(err) from err
    return sherpa_onnx


class SherpaDiarizer:
    """Thin wrapper around ``sherpa_onnx.OfflineSpeakerDiarization``.

    ``num_speakers=0`` lets the clustering threshold decide how many
    speakers there are; passing an exact count when the user knows it is
    usually the single biggest accuracy win (the 3D-Speaker ERes2Net model
    splits a 4-speaker sample into 7 at threshold 0.5 on auto).
    """

    def __init__(
        self,
        segmentation_model,
        embedding_model,
        *,
        num_speakers: int = 0,
        threshold: float = 0.5,
        num_threads: Optional[int] = None,
        refine: bool = True,
    ) -> None:
        sherpa_onnx = _import_sherpa_onnx()

        threads = int(num_threads) if num_threads else default_num_threads()
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(segmentation_model),
                ),
                num_threads=threads,
                provider="cpu",
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(embedding_model),
                num_threads=threads,
                provider="cpu",
            ),
            clustering=sherpa_onnx.FastClusteringConfig(
                num_clusters=to_sherpa_num_clusters(num_speakers),
                threshold=float(threshold),
            ),
            min_duration_on=_MIN_DURATION_ON,
            min_duration_off=_MIN_DURATION_OFF,
        )
        if not config.validate():
            raise ValueError(
                "invalid diarization config; check the model paths: "
                f"{segmentation_model}, {embedding_model}"
            )
        self._engine = sherpa_onnx.OfflineSpeakerDiarization(config)
        # Kept so refinement can honour it: the Settings field is a promise,
        # and a post-pass heuristic must not quietly undercut it.
        self._num_speakers = max(0, int(num_speakers or 0))
        self._refine_enabled = bool(refine)

        # A second handle on the SAME embedding model, used to score one
        # embedding per returned turn so refine_labels() can tell a split
        # speaker from two speakers.  sherpa's diarizer does not expose the
        # embeddings it computed internally.
        #
        # Built LAZILY, and that matters twice over.  It is not free --
        # measured +38.8 MB RSS and 0.19 s -- so switching refinement off has
        # to actually avoid it, and it used to be constructed unconditionally
        # even with diarize_refine=False.  It is also the one piece of
        # refinement machinery that would sit outside _refine's failure
        # boundary if built here, and _run_diarization has no try/except of
        # its own: a constructor failure would therefore throw away a
        # completed Whisper decode, which is exactly what that boundary
        # exists to prevent.  Building it inside the boundary fixes both.
        self._make_extractor = lambda: sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(embedding_model),
                num_threads=threads,
                provider="cpu",
            )
        )
        self._extractor_cache = None

    def diarize_file(
        self,
        audio_path,
        *,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> list[SpeakerTurn]:
        # Reuse the app's own ffmpeg-CLI decoder, which already produces
        # the 16 kHz mono float32 sherpa-onnx wants.  Deliberately not
        # faster_whisper.decode_audio: that one breaks on PyAV 19.
        from .vad.base import load_audio

        samples = load_audio(str(audio_path), sample_rate=SAMPLE_RATE)
        return self.diarize_samples(samples, on_progress=on_progress)

    # The caller hands us ONE progress band and refinement is the tail of it,
    # so the split belongs here rather than in the transcriber: only this
    # class knows the two passes exist.  Measured on a 64-minute file, the
    # sherpa pass is about 255 s and refinement 11-20 s, so refinement gets
    # the last 7%.  Without this the bar sat at the top of the band for the
    # whole of refinement -- the longest un-ticked step in the pipeline.
    _REFINE_PROGRESS_SHARE = 0.07

    @property
    def _will_refine(self) -> bool:
        """Will the refinement pass actually do anything?

        One predicate, because two callers need the same answer and they
        drifted apart once already: the progress split checked only the
        on/off switch, so a pinned speaker count -- which skips refinement
        for a different reason -- left the band stranded at 93%.
        """
        return self._refine_enabled and self._num_speakers <= 0

    def diarize_samples(
        self,
        samples,
        *,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> list[SpeakerTurn]:
        # Only reserve the tail for refinement if refinement will actually
        # run.  Otherwise the engine owns the whole band -- a band that stops
        # short leaves the bar parked below its top for the rest of the
        # stage, which is the same complaint the reservation exists to fix.
        engine_share = (
            1.0 - self._REFINE_PROGRESS_SHARE if self._will_refine else 1.0
        )

        def _callback(processed: int, total: int) -> int:
            if on_progress is not None and total > 0:
                on_progress(processed / total * engine_share)
            return 0  # a non-zero return aborts the run

        result = self._engine.process(samples, callback=_callback).sort_by_start_time()
        turns = renumber_turns(result)
        raw_speakers = len({turn.speaker for turn in turns})
        turns = self._refine(samples, turns, on_progress=on_progress)
        _log.info(
            "diarization found %d turns, %d speakers (%d before refinement)",
            len(turns),
            len({turn.speaker for turn in turns}),
            raw_speakers,
        )
        return turns

    @property
    def _extractor(self):
        """The embedding extractor, built on first use.

        Only ever touched from inside _refine's failure boundary, so a
        construction failure degrades to sherpa's labels rather than losing
        the caller's transcription.
        """
        if self._extractor_cache is None:
            self._extractor_cache = self._make_extractor()
        return self._extractor_cache

    def _embed_turn(self, samples, turn) -> Optional[list]:
        """One embedding for a turn, or None when it is too short to trust.

        The returned vector is NOT unit length -- measured L2 5.4 to about
        17 on the turns this function actually embeds, median about 8 -- so
        the caller normalises.
        """
        span = turn.end - turn.start
        if span < MIN_EMBED_SECONDS:
            return None
        if span > MAX_EMBED_SECONDS:
            middle = 0.5 * (turn.start + turn.end)
            start = middle - MAX_EMBED_SECONDS / 2
            end = middle + MAX_EMBED_SECONDS / 2
        else:
            start, end = turn.start, turn.end
        chunk = samples[max(0, int(start * SAMPLE_RATE)):int(end * SAMPLE_RATE)]
        if len(chunk) < int(0.1 * SAMPLE_RATE):
            return None
        stream = self._extractor.create_stream()
        stream.accept_waveform(SAMPLE_RATE, chunk.tolist())
        stream.input_finished()
        if not self._extractor.is_ready(stream):
            return None
        return self._extractor.compute(stream)

    def _refine(
        self,
        samples,
        turns: list[SpeakerTurn],
        *,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> list[SpeakerTurn]:
        """Collapse clusters sherpa split off the same speaker.

        Returns the turns unchanged -- same objects, same count -- if there
        is nothing to repair or if ANYTHING goes wrong.  That boundary is the
        point: refinement only polishes labels, and by the time it runs the
        caller is holding a Whisper decode that cost minutes.  Losing that to
        a label-polishing pass would be a far worse bug than the mislabelling
        this pass exists to fix, so every failure mode -- a missing numpy, an
        extractor that will not report its dimension, a bad array shape --
        degrades to the raw sherpa labels rather than raising.
        """
        if not self._refine_enabled or len(turns) < 2:
            return turns
        if not self._will_refine:
            # A pinned count makes refinement a provable no-op, so it must not
            # be paid for.  sherpa's num_clusters is a cut-at-k, so it returns
            # AT MOST the pinned number; both stages are then floored at that
            # number -- merging is blocked outright and absorb_debris promotes
            # every cluster into `keep` -- so not one label can change.  Before
            # this it still built the extractor and embedded every turn:
            # measured 36.7 MB and 16.8 s spent to return the input.
            _log.info(
                "speaker refinement skipped: %d speakers pinned, so there is "
                "nothing it could change",
                self._num_speakers,
            )
            return turns
        try:
            return self._refined_turns(samples, turns, on_progress=on_progress)
        except Exception as exc:
            _log.warning(
                "speaker refinement failed, keeping sherpa's labels: %s: %s",
                type(exc).__name__,
                exc,
            )
            return turns

    def _refined_turns(
        self,
        samples,
        turns: list[SpeakerTurn],
        *,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> list[SpeakerTurn]:
        """The body of _refine, free to raise -- _refine is the boundary."""
        import numpy as np

        started = time.monotonic()
        dim = self._extractor.dim
        embeddings = np.zeros((len(turns), dim), dtype=np.float64)
        usable = [False] * len(turns)
        for index, turn in enumerate(turns):
            # The guard covers the whole per-turn body, not just the call.
            # An extractor that RETURNS something unusable -- a vector of the
            # wrong width, a string -- fails in the conversion rather than in
            # the call, and before this that escaped to the outer boundary
            # and abandoned the entire repair for one bad turn.  Verified:
            # a wrong-width return used to drop a three-turn case from 2
            # speakers to 3.
            try:
                vector = self._embed_turn(samples, turn)
                if vector is not None:
                    array = np.asarray(vector, dtype=np.float64)
                    norm = float(np.linalg.norm(array))
                    if np.isfinite(norm) and norm > 0:
                        embeddings[index] = array / norm
                        usable[index] = True
            except Exception as exc:
                _log.debug("embedding turn %d failed: %s", index, exc)

            if on_progress is not None:
                # The embedding loop is what scales with the recording, so it
                # carries the whole refinement share.  Throttling is the
                # caller's job: ProgressThrottle already rate-limits emits.
                base = 1.0 - self._REFINE_PROGRESS_SHARE
                fraction = (index + 1) / len(turns)
                on_progress(base + self._REFINE_PROGRESS_SHARE * fraction)

        durations = [turn.end - turn.start for turn in turns]
        labels = refine_labels(
            [turn.speaker for turn in turns],
            embeddings,
            usable,
            durations,
        )
        _log.info(
            "speaker refinement: embedded %d/%d turns in %.1fs",
            sum(usable),
            len(turns),
            time.monotonic() - started,
        )
        return [
            SpeakerTurn(turn.start, turn.end, label)
            for turn, label in zip(turns, labels)
        ]
