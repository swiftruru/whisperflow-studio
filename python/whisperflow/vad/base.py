# Rewritten from faster-whisper-webui src/vad.py (Apache 2.0, (c) aadnk).
# This file contains the VAD orchestration: AbstractVadTranscription,
# NonSpeechStrategy, TranscriptionConfig, and the shared helpers
# (load_audio, get_audio_duration, adjust_timestamps, fill_gaps, etc.).
# Concrete VAD implementations live in silero.py / periodic.py.
#
# Changes vs. upstream: dataclass config, type hints everywhere, prints
# replaced by a logger, removed the tensorflow workaround that was a
# leftover from the openai/whisper era, and the "whisper progress hook"
# thread-local handle is gone (faster-whisper reports per-segment progress
# directly via its generator).  See /NOTICES.md for license details.

from __future__ import annotations

import enum
import logging
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

import ffmpeg
import numpy as np

from ..models.whisper_container import TranscribeResult, WhisperCallback
from ..progress import NullProgressListener, ProgressListener, SubTaskProgressListener
from ..subtitles.writers import format_timestamp
from .segments import merge_timestamps

_log = logging.getLogger(__name__)


# --- constants ---------------------------------------------------------

SILERO_SPEECH_THRESHOLD = 0.3
MIN_SEGMENT_DURATION = 1.0  # seconds
PROMPT_NO_SPEECH_PROB_MAX = 0.1
VAD_MAX_PROCESSING_CHUNK = 60 * 60  # seconds (1 hour)


class NonSpeechStrategy(enum.Enum):
    """What to do with audio regions the VAD decided weren't speech."""

    SKIP = "skip"
    """Ignore non-speech regions entirely."""

    CREATE_SEGMENT = "create_segment"
    """Emit a separate gap segment so the transcriber sees the whole audio."""

    EXPAND_SEGMENT = "expand_segment"
    """Stretch each speech segment to cover the silence after it."""


@dataclass
class TranscriptionConfig:
    """Options that drive VAD segment selection and merging."""

    non_speech_strategy: NonSpeechStrategy = NonSpeechStrategy.SKIP
    segment_padding_left: Optional[float] = None
    segment_padding_right: Optional[float] = None
    max_silent_period: Optional[float] = None
    max_merge_size: Optional[float] = None
    max_prompt_window: Optional[float] = None
    initial_segment_index: int = -1


@dataclass
class PeriodicTranscriptionConfig(TranscriptionConfig):
    """Extra knob for :class:`~whisperflow.vad.periodic.PeriodicVad`."""

    periodic_duration: float = 30.0


# --- orchestration -----------------------------------------------------


class AbstractVadTranscription:
    """Base class that drives a VAD + Whisper transcription loop.

    Concrete VADs implement :meth:`get_speech_timestamps` (called once per
    audio file) and inherit the merging/orchestration logic from here.
    """

    def __init__(self, *, sampling_rate: int = 16000) -> None:
        self.sampling_rate = sampling_rate

    # ---- override points ------------------------------------------

    def get_speech_timestamps(
        self,
        audio_path: str,
        config: TranscriptionConfig,
        start_time: float,
        end_time: float,
    ) -> list[dict]:
        """Return a list of ``{start, end}`` dicts (in seconds) for this audio."""
        raise NotImplementedError

    def is_fast_vad(self) -> bool:
        """Return True if timestamp extraction is cheap enough that splitting
        it across worker processes wouldn't help.  Parallel VAD honours this."""
        return False

    # ---- audio helpers --------------------------------------------

    def load_audio_segment(
        self,
        audio_path: str,
        *,
        start_time: Optional[str] = None,
        duration: Optional[str] = None,
    ) -> np.ndarray:
        return load_audio(audio_path, sample_rate=self.sampling_rate, start_time=start_time, duration=duration)

    def get_audio_duration(self, audio_path: str, config: TranscriptionConfig) -> float:
        return get_audio_duration(audio_path)

    # ---- timestamp merging ----------------------------------------

    def get_merged_timestamps(
        self,
        timestamps: list[dict],
        config: TranscriptionConfig,
        total_duration: float,
    ) -> list[dict]:
        merged = merge_timestamps(
            timestamps,
            merge_window=config.max_silent_period,
            max_merge_size=config.max_merge_size,
            padding_left=config.segment_padding_left,
            padding_right=config.segment_padding_right,
        )

        if config.non_speech_strategy is NonSpeechStrategy.SKIP:
            return merged

        if config.non_speech_strategy is NonSpeechStrategy.CREATE_SEGMENT:
            merged = self.fill_gaps(merged, total_duration=total_duration, max_expand_size=config.max_merge_size)
        elif config.non_speech_strategy is NonSpeechStrategy.EXPAND_SEGMENT:
            merged = self.expand_gaps(merged, total_duration=total_duration)
        else:
            raise ValueError(f"unknown non-speech strategy: {config.non_speech_strategy}")

        _log.info("non-speech strategy %s produced %d segments", config.non_speech_strategy.value, len(merged))
        return merged

    # ---- main driver ----------------------------------------------

    def transcribe(
        self,
        audio_path: str,
        callback: WhisperCallback,
        config: TranscriptionConfig,
        *,
        progress_listener: Optional[ProgressListener] = None,
    ) -> TranscribeResult:
        """Run VAD + Whisper over a whole audio file.

        The flow is:
          1. Probe the file's duration.
          2. Ask the subclass for speech timestamps.
          3. Merge adjacent segments (and optionally fill gaps).
          4. For each resulting segment, decode PCM via ffmpeg and call
             the :class:`WhisperCallback`.
          5. Adjust each segment's returned timestamps back into the
             original audio's coordinate space.
          6. Maintain a rolling prompt window of previously transcribed
             segments (bounded by ``config.max_prompt_window``).
        """
        listener = progress_listener or NullProgressListener()

        try:
            total_duration = self.get_audio_duration(audio_path, config)
            raw_timestamps = self.get_speech_timestamps(audio_path, config, 0.0, total_duration)
            merged = self.get_merged_timestamps(raw_timestamps, config, total_duration)

            prompt_window: deque = deque()
            language_counter: Counter[str] = Counter()
            detected_language: Optional[str] = None
            segment_index = config.initial_segment_index

            result: TranscribeResult = {"text": "", "segments": [], "language": None}

            if not merged:
                return result

            progress_start = merged[0]["start"]
            progress_total = sum(s["end"] - s["start"] for s in merged)

            for segment in merged:
                segment_index += 1
                seg_start = segment["start"]
                seg_end = segment["end"]
                seg_duration = seg_end - seg_start
                seg_expand = segment.get("expand_amount", 0)
                seg_is_gap = bool(segment.get("gap", False))

                if seg_duration < MIN_SEGMENT_DURATION:
                    continue

                audio_chunk = self.load_audio_segment(
                    audio_path,
                    start_time=str(seg_start),
                    duration=str(seg_duration),
                )
                rolling_prompt = (
                    " ".join(s["text"] for s in prompt_window) if prompt_window else None
                )
                detected_language = language_counter.most_common(1)[0][0] if language_counter else None

                _log.info(
                    "whisper %s -> %s (duration=%.2fs expand=%.2f lang=%s)",
                    format_timestamp(seg_start),
                    format_timestamp(seg_end),
                    seg_duration,
                    seg_expand,
                    detected_language,
                )

                perf_start = time.perf_counter()
                sub_listener = SubTaskProgressListener(
                    listener,
                    parent_total=progress_total,
                    sub_start=seg_start - progress_start,
                    sub_total=seg_duration,
                )
                segment_result = callback.invoke(
                    audio_chunk,
                    segment_index,
                    rolling_prompt,
                    detected_language,
                    progress_listener=sub_listener,
                )
                _log.debug("whisper segment took %.2fs", time.perf_counter() - perf_start)

                adjusted = self.adjust_timestamps(
                    segment_result["segments"],
                    offset=seg_start,
                    max_source_time=seg_duration,
                )

                if seg_expand > 0:
                    body_end = seg_duration - seg_expand
                    for adj in adjusted:
                        local_end = adj["end"] - seg_start
                        if local_end > body_end:
                            adj["expand_amount"] = local_end - body_end

                result["text"] += segment_result["text"]
                result["segments"].extend(adjusted)

                if not seg_is_gap and segment_result.get("language"):
                    language_counter[segment_result["language"]] += 1

                self._update_prompt_window(prompt_window, adjusted, seg_end, seg_is_gap, config)

            if detected_language is not None:
                result["language"] = detected_language

            return result
        finally:
            listener.on_finished()

    # ---- prompt window --------------------------------------------

    def _update_prompt_window(
        self,
        prompt_window: deque,
        adjusted_segments: list[dict],
        segment_end: float,
        segment_is_gap: bool,
        config: TranscriptionConfig,
    ) -> None:
        if not config.max_prompt_window or config.max_prompt_window <= 0:
            return

        if not segment_is_gap:
            for seg in adjusted_segments:
                if seg.get("no_speech_prob", 0) <= PROMPT_NO_SPEECH_PROB_MAX:
                    prompt_window.append(seg)

        cutoff = segment_end - config.max_prompt_window
        while prompt_window:
            head = prompt_window[0]
            end_time = head.get("end", 0) - head.get("expand_amount", 0)
            if end_time < cutoff:
                prompt_window.popleft()
            else:
                break

    # ---- gap helpers ----------------------------------------------

    def expand_gaps(self, segments: list[dict], total_duration: float) -> list[dict]:
        """Stretch each segment's end to touch the next segment's start."""
        if not segments:
            return []

        result: list[dict] = []
        if segments[0]["start"] > 0:
            result.append({"start": 0, "end": segments[0]["start"], "gap": True})

        for current, nxt in zip(segments, segments[1:]):
            delta = nxt["start"] - current["end"]
            if delta >= 0:
                current = dict(current)
                current["expand_amount"] = delta
                current["end"] = nxt["start"]
            result.append(current)
        result.append(segments[-1])

        if total_duration is not None and result[-1]["end"] < total_duration:
            last = dict(result[-1])
            last["end"] = total_duration
            result[-1] = last
        return result

    def fill_gaps(
        self,
        segments: list[dict],
        *,
        total_duration: float,
        max_expand_size: Optional[float] = None,
    ) -> list[dict]:
        """Either expand small gaps into the previous segment, or insert an
        explicit ``gap=True`` segment for large ones."""
        if not segments:
            return []

        result: list[dict] = []
        if segments[0]["start"] > 0:
            result.append({"start": 0, "end": segments[0]["start"], "gap": True})

        for current, nxt in zip(segments, segments[1:]):
            expanded = False
            delta = nxt["start"] - current["end"]

            if max_expand_size is not None and 0 <= delta <= max_expand_size:
                current = dict(current)
                current["expand_amount"] = delta
                current["end"] = nxt["start"]
                expanded = True

            result.append(current)

            if delta >= 0 and not expanded:
                result.append({"start": current["end"], "end": nxt["start"], "gap": True})

        result.append(segments[-1])

        if total_duration is not None:
            last = result[-1]
            delta = total_duration - last["end"]
            if delta > 0:
                if max_expand_size is not None and delta <= max_expand_size:
                    last = dict(last)
                    last["expand_amount"] = delta
                    last["end"] = total_duration
                    result[-1] = last
                else:
                    result.append({"start": last["end"], "end": total_duration, "gap": True})
        return result

    # ---- timestamp math -------------------------------------------

    def adjust_timestamps(
        self,
        segments: Iterable[dict],
        *,
        offset: float,
        max_source_time: Optional[float] = None,
    ) -> list[dict]:
        """Add ``offset`` to each segment's (and word's) timestamps.

        If ``max_source_time`` is given, segments whose local start is past
        that cutoff are dropped, and segments that overlap the cutoff have
        their end clamped.
        """
        result: list[dict] = []
        for segment in segments:
            local_start = float(segment["start"])
            local_end = float(segment["end"])

            if max_source_time is not None:
                if local_start > max_source_time:
                    continue
                local_end = min(max_source_time, local_end)

            new_segment = dict(segment)
            new_segment["start"] = local_start + offset
            new_segment["end"] = local_end + offset

            for word in new_segment.get("words") or []:
                word["start"] = word["start"] + offset
                word["end"] = word["end"] + offset

            result.append(new_segment)
        return result

    def multiply_timestamps(self, timestamps: Iterable[dict], factor: float) -> list[dict]:
        return [{"start": t["start"] * factor, "end": t["end"] * factor} for t in timestamps]


# --- ffmpeg helpers ----------------------------------------------------


def get_audio_duration(path: str) -> float:
    """Return the media duration in seconds via ``ffprobe``."""
    return float(ffmpeg.probe(path)["format"]["duration"])


def load_audio(
    path: str,
    *,
    sample_rate: int = 16000,
    start_time: Optional[str] = None,
    duration: Optional[str] = None,
) -> np.ndarray:
    """Decode an audio/video file as a float32 mono waveform at ``sample_rate`` Hz.

    Uses the ``ffmpeg`` CLI (must be on PATH).  ``start_time`` and ``duration``
    are passed through as ffmpeg ``-ss`` and ``-t`` strings.
    """
    input_kwargs: dict[str, Any] = {"threads": 0}
    if start_time is not None:
        input_kwargs["ss"] = start_time
    if duration is not None:
        input_kwargs["t"] = duration

    try:
        out, _ = (
            ffmpeg.input(path, **input_kwargs)
            .output("-", format="s16le", acodec="pcm_s16le", ac=1, ar=sample_rate)
            .run(cmd="ffmpeg", capture_stdout=True, capture_stderr=True)
        )
    except ffmpeg.Error as err:
        stderr = err.stderr.decode("utf-8", errors="replace") if err.stderr else str(err)
        raise RuntimeError(f"failed to load audio: {stderr}") from err

    return np.frombuffer(out, np.int16).flatten().astype(np.float32) / 32768.0
