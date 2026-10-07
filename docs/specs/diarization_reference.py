# Speaker diarization ("who spoke when") for WhisperFlow Studio.
#
# REFERENCE IMPLEMENTATION (verified 2026-10-07, see speaker-diarization.md
# section 3).  Not imported by the app.  The real module should be written
# at ``python/whisperflow/diarization.py`` following the spec, in project
# style, with tests and the model-download logic from spec section 4.3.
# Engine: sherpa-onnx (Apache-2.0), which runs the pyannote
# segmentation-3.0 model (MIT, (c) CNRS) plus a speaker-embedding model
# (e.g. 3D-Speaker CAM++) on ONNX Runtime.  No torch, no Hugging Face
# token, and wheels exist for every platform the app ships on
# (macOS arm64 + x86_64, Windows, Linux).
#
# Pipeline position: after ``Transcriber._run_vad`` (Whisper segments are
# already on the global timeline) and before ``_write_outputs``.

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence

_log = logging.getLogger(__name__)

SAMPLE_RATE = 16_000


@dataclass(frozen=True)
class SpeakerTurn:
    """One contiguous stretch of a single speaker, in seconds."""

    start: float
    end: float
    speaker: int  # 0-based, numbered by order of first appearance


class SherpaDiarizer:
    """Thin wrapper around ``sherpa_onnx.OfflineSpeakerDiarization``.

    ``num_speakers=-1`` lets the clustering threshold decide how many
    speakers there are; pass an exact count when the user knows it
    (that is usually the single biggest accuracy win).
    """

    def __init__(
        self,
        segmentation_model: Path,
        embedding_model: Path,
        *,
        num_speakers: int = -1,
        threshold: float = 0.5,
        num_threads: int = 2,
    ) -> None:
        import sherpa_onnx  # lazy: only imported when diarization is on

        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(segmentation_model),
                ),
                num_threads=num_threads,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(embedding_model),
                num_threads=num_threads,
            ),
            clustering=sherpa_onnx.FastClusteringConfig(
                num_clusters=num_speakers,
                threshold=threshold,
            ),
            min_duration_on=0.3,
            min_duration_off=0.5,
        )
        if not config.validate():
            raise ValueError("invalid diarization config; check the model paths")
        self._engine = sherpa_onnx.OfflineSpeakerDiarization(config)

    def diarize_file(
        self,
        audio_path: str,
        *,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> list[SpeakerTurn]:
        # Reuse the app's own ffmpeg-CLI decoder (16 kHz mono float32,
        # exactly what sherpa-onnx wants).  Deliberately NOT
        # faster_whisper.decode_audio: it breaks on PyAV 19.
        from .vad.base import load_audio

        samples = load_audio(audio_path, sample_rate=SAMPLE_RATE)
        return self.diarize_samples(samples, on_progress=on_progress)

    def diarize_samples(
        self,
        samples,
        *,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> list[SpeakerTurn]:
        def _callback(done: int, total: int) -> int:
            if on_progress is not None and total > 0:
                on_progress(done / total)
            return 0  # non-zero would abort

        result = self._engine.process(samples, callback=_callback).sort_by_start_time()
        # Raw cluster ids are not contiguous (4 speakers can come back as
        # 0, 1, 2, 7), so renumber them by order of first appearance.
        renumber: dict[int, int] = {}
        turns = []
        for s in result:
            speaker = renumber.setdefault(int(s.speaker), len(renumber))
            turns.append(SpeakerTurn(float(s.start), float(s.end), speaker))
        _log.info("diarization found %d turns, %d speakers", len(turns), len({t.speaker for t in turns}))
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

    With word timestamps (``word_timestamps=True`` in faster-whisper),
    each word gets its own speaker and, if ``split_on_change`` is set, a
    segment that spans a speaker change is split into one segment per
    speaker.  Without words, the whole segment goes to the speaker with
    the largest time overlap.
    """
    if not turns:
        return segments

    out: list[dict] = []
    for segment in segments:
        words = segment.get("words") or []
        if not words:
            out.append({**segment, "speaker": _speaker_for_span(turns, segment["start"], segment["end"])})
            continue

        labelled = [{**w, "speaker": _speaker_for_span(turns, w["start"], w["end"])} for w in words]
        _smooth(labelled, min_run_words)

        if not split_on_change:
            out.append({**segment, "words": labelled, "speaker": _majority(labelled)})
            continue
        out.extend(_split_by_speaker(segment, labelled))
    return out


def speaker_label(speaker: Optional[int], template: str = "Speaker {n}") -> str:
    """0-based speaker index -> human label ("Speaker 1", "講者 1", ...)."""
    return "" if speaker is None else template.format(n=speaker + 1)


def _speaker_for_span(turns: Sequence[SpeakerTurn], start: float, end: float) -> int:
    overlap: dict[int, float] = {}
    for t in turns:
        if t.end <= start:
            continue
        if t.start >= end:
            break  # turns are sorted by start time
        overlap[t.speaker] = overlap.get(t.speaker, 0.0) + min(end, t.end) - max(start, t.start)
    if overlap:
        return max(overlap, key=overlap.__getitem__)
    # No overlap (e.g. a word inside a short pause): use the nearest turn.
    middle = (start + end) / 2
    nearest = min(turns, key=lambda t: 0.0 if t.start <= middle <= t.end else min(abs(t.start - middle), abs(t.end - middle)))
    return nearest.speaker


def _smooth(words: list[dict], min_run_words: int) -> None:
    """Absorb tiny runs (boundary jitter) into the surrounding speaker."""
    if min_run_words <= 1:
        return
    runs = _runs(words)
    for i, (start, stop, speaker) in enumerate(runs):
        if stop - start >= min_run_words:
            continue
        prev_spk = runs[i - 1][2] if i > 0 else None
        next_spk = runs[i + 1][2] if i + 1 < len(runs) else None
        replacement = prev_spk if prev_spk is not None else next_spk
        if prev_spk is not None and next_spk is not None and prev_spk != next_spk:
            continue  # a real hand-over between two speakers, keep it
        if replacement is not None:
            for w in words[start:stop]:
                w["speaker"] = replacement


def _runs(words: list[dict]) -> list[tuple[int, int, int]]:
    runs: list[tuple[int, int, int]] = []
    start = 0
    for i in range(1, len(words) + 1):
        if i == len(words) or words[i]["speaker"] != words[start]["speaker"]:
            runs.append((start, i, words[start]["speaker"]))
            start = i
    return runs


def _split_by_speaker(segment: dict, words: list[dict]) -> list[dict]:
    runs = _runs(words)
    pieces = []
    for index, (start, stop, speaker) in enumerate(runs):
        chunk = words[start:stop]
        pieces.append(
            {
                **segment,
                "start": segment["start"] if index == 0 else chunk[0]["start"],
                "end": segment["end"] if index == len(runs) - 1 else chunk[-1]["end"],
                "text": "".join(w["word"] for w in chunk),
                "words": chunk,
                "speaker": speaker,
            }
        )
    return pieces


def _majority(words: list[dict]) -> int:
    weight: dict[int, float] = {}
    for w in words:
        weight[w["speaker"]] = weight.get(w["speaker"], 0.0) + (w["end"] - w["start"])
    return max(weight, key=weight.__getitem__)
