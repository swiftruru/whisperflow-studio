# Rewritten from faster-whisper-webui src/whisper/fasterWhisperContainer.py
# (Apache 2.0, (c) aadnk).  Changes: dropped the openai/whisper compat branch
# (this project is faster-whisper only), dropped the ModelConfig list in
# favour of registry lookup, routed model download through ModelManager so
# weights land in the app-managed directory instead of ~/.cache/huggingface,
# fixed the fp16 warning to use logging, uses the new language resolver.
# See /NOTICES.md for license details.

from __future__ import annotations

import logging
from typing import Any, Optional, Union

from faster_whisper import WhisperModel

from ..languages import resolve_language_code
from ..progress import ProgressListener
from ..prompts.base import PromptStrategy
from ..subtitles.writers import format_timestamp
from .cache import ModelCache
from .device_probe import resolve_device_and_compute_type
from .whisper_container import TranscribeResult, WhisperCallback, WhisperContainer

_log = logging.getLogger(__name__)


class FasterWhisperBackend(WhisperContainer):
    """WhisperContainer implementation backed by the ``faster_whisper`` library."""

    def __init__(
        self,
        model_name: str,
        *,
        device: Optional[str] = None,
        compute_type: str = "auto",
        model_dir: Optional[str] = None,
        cache: Optional[ModelCache] = None,
    ) -> None:
        super().__init__(
            model_name,
            device=device,
            compute_type=compute_type,
            model_dir=model_dir,
            cache=cache,
        )

    def ensure_downloaded(self) -> None:
        """Pre-download weights so parallel workers don't race each other."""
        from faster_whisper import download_model  # lazy import so tests don't need it

        import os

        if os.path.isdir(self.model_name):
            return  # already a local path
        download_model(self.model_name, output_dir=self.model_dir)

    def _build_model(self) -> WhisperModel:
        resolved_device, resolved_compute_type, warning = resolve_device_and_compute_type(
            self.device or "auto",
            self.compute_type,
        )
        if warning:
            _log.warning(warning)
        self.device = resolved_device
        self.compute_type = resolved_compute_type
        _log.info(
            "loading faster-whisper model %s (device=%s, compute_type=%s)",
            self.model_name,
            resolved_device,
            resolved_compute_type,
        )
        return WhisperModel(
            self.model_name,
            device=resolved_device,
            compute_type=resolved_compute_type,
            download_root=self.model_dir,
        )

    def create_callback(
        self,
        *,
        language: Optional[str] = None,
        task: Optional[str] = None,
        prompt_strategy: Optional[PromptStrategy] = None,
        **decode_options: Any,
    ) -> "FasterWhisperCallback":
        return FasterWhisperCallback(
            self,
            language=language,
            task=task,
            prompt_strategy=prompt_strategy,
            decode_options=decode_options,
        )


class FasterWhisperCallback:
    """Per-job transcription callback produced by :class:`FasterWhisperBackend`.

    The VAD layer constructs one of these and then calls :meth:`invoke` once
    per audio chunk.  Decode options that don't map cleanly onto faster-whisper
    are normalised here (``fp16`` is a no-op, ``logprob_threshold`` is renamed,
    string ``suppress_tokens`` are split).
    """

    def __init__(
        self,
        backend: FasterWhisperBackend,
        *,
        language: Optional[str],
        task: Optional[str],
        prompt_strategy: Optional[PromptStrategy],
        decode_options: dict,
    ) -> None:
        self._backend = backend
        self._language = language
        self._task = task
        self._prompt_strategy = prompt_strategy
        self._decode_options = dict(decode_options)
        self._warned_about_fp16 = False

    def invoke(
        self,
        audio: Any,
        segment_index: int,
        prompt: Optional[str],
        detected_language: Optional[str],
        progress_listener: Optional[ProgressListener] = None,
    ) -> TranscribeResult:
        model: WhisperModel = self._backend.get_model()
        language_code = resolve_language_code(self._language) if self._language else None

        decode = self._normalise_decode_options(dict(self._decode_options))

        initial_prompt = (
            self._prompt_strategy.get_segment_prompt(segment_index, prompt, detected_language)
            if self._prompt_strategy is not None
            else prompt
        )

        verbose = decode.pop("verbose", False)

        segments_iter, info = model.transcribe(
            audio,
            language=language_code or detected_language,
            task=self._task,
            initial_prompt=initial_prompt,
            **decode,
        )

        collected = []
        for segment in segments_iter:
            collected.append(segment)
            if progress_listener is not None:
                progress_listener.on_progress(segment.end, info.duration)
            if verbose:
                _log.info(
                    "[%s -> %s] %s",
                    format_timestamp(segment.start, always_include_hours=True),
                    format_timestamp(segment.end, always_include_hours=True),
                    segment.text,
                )

        result: TranscribeResult = {
            "segments": [
                {
                    "text": s.text,
                    "start": s.start,
                    "end": s.end,
                    "words": [
                        {
                            "start": w.start,
                            "end": w.end,
                            "word": w.word,
                            "probability": w.probability,
                        }
                        for w in (s.words or [])
                    ],
                }
                for s in collected
            ],
            "text": " ".join(s.text for s in collected),
            "language": info.language if info else None,
            "language_probability": info.language_probability if info else None,
            "duration": info.duration if info else None,
        }

        if self._prompt_strategy is not None:
            self._prompt_strategy.on_segment_finished(segment_index, prompt, detected_language, result)

        if progress_listener is not None:
            progress_listener.on_finished()

        return result

    def _normalise_decode_options(self, options: dict) -> dict:
        # faster-whisper ignores fp16 entirely (controlled by compute_type).
        if options.pop("fp16", None) is not None and not self._warned_about_fp16:
            _log.warning("fp16 option is ignored by faster-whisper; use compute_type instead")
            self._warned_about_fp16 = True

        # Upstream whisper used ``logprob_threshold``; faster-whisper expects
        # ``log_prob_threshold``.
        if "logprob_threshold" in options:
            options["log_prob_threshold"] = options.pop("logprob_threshold")

        options["patience"] = float(options.get("patience") or 1.0)
        options["length_penalty"] = float(options.get("length_penalty") or 1.0)
        options["suppress_tokens"] = _split_suppress_tokens(options.get("suppress_tokens"))
        return options


def _split_suppress_tokens(value: Union[None, str, list[int]]) -> Optional[list[int]]:
    if value is None:
        return None
    if isinstance(value, list):
        return value
    return [int(token) for token in value.split(",") if token]
