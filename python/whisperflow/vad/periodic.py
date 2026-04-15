# Rewritten from faster-whisper-webui src/vad.py (VadPeriodicTranscription)
# (Apache 2.0, (c) aadnk).  Changes: uses PeriodicTranscriptionConfig from
# base.py, modern type hints.  See /NOTICES.md for license details.

from __future__ import annotations

from .base import (
    MIN_SEGMENT_DURATION,
    AbstractVadTranscription,
    PeriodicTranscriptionConfig,
    TranscriptionConfig,
)


class PeriodicVad(AbstractVadTranscription):
    """Trivial VAD that cuts audio into fixed-duration chunks.

    Useful as a fallback when silero-vad is unavailable, or when the caller
    wants deterministic chunking for debugging.  Requires a
    :class:`PeriodicTranscriptionConfig`.
    """

    def is_fast_vad(self) -> bool:
        return True

    def get_speech_timestamps(
        self,
        audio_path: str,
        config: TranscriptionConfig,
        start_time: float,
        end_time: float,
    ) -> list[dict]:
        if not isinstance(config, PeriodicTranscriptionConfig):
            raise TypeError("PeriodicVad requires a PeriodicTranscriptionConfig")

        result: list[dict] = []
        cursor = start_time
        while cursor < end_time:
            chunk_end = min(cursor + config.periodic_duration, end_time)
            if chunk_end - cursor >= MIN_SEGMENT_DURATION:
                result.append({"start": cursor, "end": chunk_end})
            cursor = chunk_end
        return result
