# New module (no upstream counterpart).
# Catalogues the faster-whisper models that WhisperFlow Studio supports
# out of the box.  The registry is deliberately small and opinionated:
# every entry maps to a ``Systran/faster-whisper-*`` repo on HuggingFace.

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ModelEntry:
    """Static metadata for a built-in Whisper model.

    ``repo_id`` is what ``faster_whisper.WhisperModel`` / ``download_model``
    expects.  ``approx_size_mb`` is a coarse estimate surfaced by the Model
    Manager UI so users can decide before hitting download.
    """

    name: str
    repo_id: str
    approx_size_mb: int
    description: str

    @property
    def local_dir_name(self) -> str:
        """Directory name used inside the app-managed models directory.

        We mirror HuggingFace's ``models--<org>--<name>`` convention so that
        faster-whisper's own cache layout and our managed layout stay in sync.
        """
        return "models--" + self.repo_id.replace("/", "--")


_BUILTIN_MODELS: tuple[ModelEntry, ...] = (
    ModelEntry("tiny",     "Systran/faster-whisper-tiny",     75,   "Fastest, lowest accuracy. Good for quick previews."),
    ModelEntry("base",     "Systran/faster-whisper-base",     145,  "Small & fast. Usable for simple English speech."),
    ModelEntry("small",    "Systran/faster-whisper-small",    465,  "Balanced. Handles most clean speech well."),
    ModelEntry("medium",   "Systran/faster-whisper-medium",   1500, "Good accuracy for a wide range of languages."),
    ModelEntry("large-v1", "Systran/faster-whisper-large-v1", 2900, "Legacy large model."),
    ModelEntry("large-v2", "Systran/faster-whisper-large-v2", 2900, "High accuracy. Recommended for Chinese/Japanese."),
    ModelEntry("large-v3", "Systran/faster-whisper-large-v3", 2900, "Newest large model. Best general accuracy."),
)


def all_models() -> list[ModelEntry]:
    """Return the full built-in catalogue."""
    return list(_BUILTIN_MODELS)


def get_model(name: str) -> Optional[ModelEntry]:
    """Look up a model entry by short name (``"large-v2"``) or repo id."""
    if not name:
        return None
    lower = name.lower()
    for entry in _BUILTIN_MODELS:
        if entry.name.lower() == lower or entry.repo_id.lower() == lower:
            return entry
    return None


def model_names() -> list[str]:
    """Return the list of short names (for UI dropdowns)."""
    return [entry.name for entry in _BUILTIN_MODELS]
