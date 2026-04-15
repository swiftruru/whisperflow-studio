# Rewritten from faster-whisper-webui src/whisper/abstractWhisperContainer.py
# (Apache 2.0, (c) aadnk).  Changes: reduced to the bits we actually need
# (dropped the LambdaWhisperCallback helper, dropped the whisper/openai path
# since this project is faster-whisper only), uses TranscribeResult TypedDict,
# explicit ``__getstate__``/``__setstate__`` still kept so containers can be
# sent to parallel VAD worker processes via pickle.  See /NOTICES.md.

from __future__ import annotations

from typing import Any, Optional, Protocol, TypedDict, runtime_checkable

from ..progress import ProgressListener
from ..prompts.base import PromptStrategy
from .cache import GLOBAL_MODEL_CACHE, ModelCache


class TranscribedSegment(TypedDict, total=False):
    text: str
    start: float
    end: float
    words: list[dict]


class TranscribeResult(TypedDict, total=False):
    segments: list[TranscribedSegment]
    text: str
    language: Optional[str]
    language_probability: Optional[float]
    duration: Optional[float]


@runtime_checkable
class WhisperCallback(Protocol):
    """Callable used by the VAD layer to transcribe one audio chunk."""

    def invoke(
        self,
        audio: Any,
        segment_index: int,
        prompt: Optional[str],
        detected_language: Optional[str],
        progress_listener: Optional[ProgressListener] = None,
    ) -> TranscribeResult: ...


class WhisperContainer:
    """Lazy loader + picklable handle for a Whisper-family model.

    Concrete backends (faster-whisper) subclass this and implement
    :meth:`_build_model` and :meth:`create_callback`.
    """

    def __init__(
        self,
        model_name: str,
        *,
        device: Optional[str] = None,
        compute_type: str = "auto",
        model_dir: Optional[str] = None,
        cache: Optional[ModelCache] = None,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.model_dir = model_dir
        self._cache = cache
        self._model: Any = None

    # --- lifecycle -----------------------------------------------------

    def get_model(self) -> Any:
        """Return the loaded model instance, building it on first access."""
        if self._model is not None:
            return self._model
        if self._cache is None:
            self._model = self._build_model()
        else:
            key = f"{type(self).__name__}:{self.model_name}:{self.device or ''}:{self.compute_type}"
            self._model = self._cache.get_or_create(key, self._build_model)
        return self._model

    def ensure_downloaded(self) -> None:
        """Optional hook: subclasses can pre-download weights here so that
        subprocess workers don't race on the first download."""
        return None

    def _build_model(self) -> Any:
        raise NotImplementedError

    def create_callback(
        self,
        *,
        language: Optional[str] = None,
        task: Optional[str] = None,
        prompt_strategy: Optional[PromptStrategy] = None,
        **decode_options: Any,
    ) -> WhisperCallback:
        raise NotImplementedError

    # --- pickle --------------------------------------------------------
    # The parallel VAD worker pickles the container.  We intentionally drop
    # ``_model`` and ``_cache``: workers should use the process-global cache.

    def __getstate__(self) -> dict:
        return {
            "model_name": self.model_name,
            "device": self.device,
            "compute_type": self.compute_type,
            "model_dir": self.model_dir,
        }

    def __setstate__(self, state: dict) -> None:
        self.model_name = state["model_name"]
        self.device = state["device"]
        self.compute_type = state["compute_type"]
        self.model_dir = state["model_dir"]
        self._model = None
        self._cache = GLOBAL_MODEL_CACHE
