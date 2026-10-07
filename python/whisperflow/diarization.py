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

    def diarize_samples(
        self,
        samples,
        *,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> list[SpeakerTurn]:
        def _callback(processed: int, total: int) -> int:
            if on_progress is not None and total > 0:
                on_progress(processed / total)
            return 0  # a non-zero return aborts the run

        result = self._engine.process(samples, callback=_callback).sort_by_start_time()
        turns = renumber_turns(result)
        _log.info(
            "diarization found %d turns, %d speakers",
            len(turns),
            len({turn.speaker for turn in turns}),
        )
        return turns
