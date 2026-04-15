# Rewritten from faster-whisper-webui src/vad.py (VadSileroTranscription)
# (Apache 2.0, (c) aadnk).
# Changes: configurable torch.hub cache directory (so the Silero weights
# land in the app-managed models directory instead of ~/.cache/torch),
# logger instead of prints, process-global cache honoured on unpickle.
# See /NOTICES.md for license details.

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Optional, Tuple

import torch

from ..models.cache import GLOBAL_MODEL_CACHE, ModelCache
from ..models.manager import import_silero_vad_from_system_torch_hub
from ..subtitles.writers import format_timestamp
from .base import (
    SILERO_SPEECH_THRESHOLD,
    VAD_MAX_PROCESSING_CHUNK,
    AbstractVadTranscription,
    TranscriptionConfig,
)

_log = logging.getLogger(__name__)


class SileroVad(AbstractVadTranscription):
    """Silero VAD loaded via ``torch.hub``.

    Pass ``torch_hub_dir`` (typically ``ModelManager.torch_hub_dir``) to keep
    the downloaded weights inside the app-managed models directory instead of
    the user's global torch cache.
    """

    def __init__(
        self,
        *,
        sampling_rate: int = 16000,
        cache: Optional[ModelCache] = None,
        torch_hub_dir: Optional[Path] = None,
    ) -> None:
        super().__init__(sampling_rate=sampling_rate)
        self._cache = cache
        self._torch_hub_dir = Path(torch_hub_dir) if torch_hub_dir else None
        self._model: Any = None
        self._get_speech_timestamps = None
        self._load_model()

    def _load_model(self) -> None:
        if self._torch_hub_dir is not None:
            self._torch_hub_dir.mkdir(parents=True, exist_ok=True)
            torch.hub.set_dir(str(self._torch_hub_dir))
            # If the user already has silero-vad in their system torch hub
            # cache (from any other torch.hub-based tool), pull it into the
            # managed dir so torch.hub.load skips the 10–20 MB download.
            imported = import_silero_vad_from_system_torch_hub(self._torch_hub_dir)
            if imported:
                _log.info("silero-vad imported from system torch hub cache")

        if self._cache is None:
            self._model, self._get_speech_timestamps = self._build()
            _log.info("silero VAD model loaded")
            return

        cache_key = f"SileroVad:{self._torch_hub_dir or 'default'}"
        self._model, self._get_speech_timestamps = self._cache.get_or_create(cache_key, self._build)
        _log.info("silero VAD model loaded from cache")

    @staticmethod
    def _build() -> Tuple[Any, Any]:
        # `trust_repo=True` is required from PyTorch 1.12+ when running
        # headless: without it, torch.hub asks the user via stdin "do you
        # trust snakers4/silero-vad?" and crashes with EOFError when there
        # is no TTY (which is always our case — we're a subprocess of
        # Electron).  Snakers4/silero-vad is the canonical Silero VAD repo.
        model, utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
        )
        # Silero is a small torchscript model; threading hurts more than it helps.
        torch.set_num_threads(1)
        get_speech_timestamps = utils[0]
        return model, get_speech_timestamps

    def get_speech_timestamps(
        self,
        audio_path: str,
        config: TranscriptionConfig,
        start_time: float,
        end_time: float,
    ) -> list[dict]:
        _log.info("silero VAD scanning %s (%.2fs -> %.2fs)", audio_path, start_time, end_time)
        perf_start = time.perf_counter()

        result: list[dict] = []
        chunk_start = start_time
        while chunk_start < end_time:
            chunk_duration = min(end_time - chunk_start, VAD_MAX_PROCESSING_CHUNK)

            _log.debug(
                "VAD chunk %s -> %s",
                format_timestamp(chunk_start),
                format_timestamp(chunk_start + chunk_duration),
            )
            wav = self.load_audio_segment(audio_path, start_time=str(chunk_start), duration=str(chunk_duration))

            sample_timestamps = self._get_speech_timestamps(
                wav,
                self._model,
                sampling_rate=self.sampling_rate,
                threshold=SILERO_SPEECH_THRESHOLD,
            )
            seconds_timestamps = self.multiply_timestamps(sample_timestamps, factor=1 / self.sampling_rate)
            adjusted = self.adjust_timestamps(
                seconds_timestamps,
                offset=chunk_start,
                max_source_time=chunk_duration,
            )
            result.extend(adjusted)
            chunk_start += chunk_duration

        _log.debug("silero VAD scan took %.2fs", time.perf_counter() - perf_start)
        return result

    # --- pickle (for parallel VAD workers) -----------------------------

    def __getstate__(self) -> dict:
        return {
            "sampling_rate": self.sampling_rate,
            "torch_hub_dir": str(self._torch_hub_dir) if self._torch_hub_dir else None,
        }

    def __setstate__(self, state: dict) -> None:
        self.sampling_rate = state["sampling_rate"]
        hub = state.get("torch_hub_dir")
        self._torch_hub_dir = Path(hub) if hub else None
        self._cache = GLOBAL_MODEL_CACHE
        self._model = None
        self._get_speech_timestamps = None
        self._load_model()
