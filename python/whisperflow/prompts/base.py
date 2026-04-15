# Rewritten from faster-whisper-webui src/prompts/abstractPromptStrategy.py
# and the VadInitialPromptMode enum from src/config.py (Apache 2.0, (c) aadnk).
# Changes: replaced the abstract-base-class pattern with a Protocol, added the
# InitialPromptMode enum here (it's fundamentally a prompt concept, not a VAD
# one), and renamed PREPREND_FIRST_SEGMENT -> PREPEND_FIRST_SEGMENT (typo fix).
# See /NOTICES.md for license details.

from __future__ import annotations

import enum
from typing import Optional, Protocol, runtime_checkable


class InitialPromptMode(enum.Enum):
    """How the user-supplied initial prompt should be injected into Whisper."""

    PREPEND_ALL_SEGMENTS = "prepend_all_segments"
    PREPEND_FIRST_SEGMENT = "prepend_first_segment"
    JSON_PROMPT_MODE = "json_prompt_mode"

    @classmethod
    def parse(cls, value: str) -> "InitialPromptMode":
        """Accept either the enum value or a case-insensitive string."""
        if isinstance(value, cls):
            return value
        normalized = value.strip().lower()
        for member in cls:
            if member.value == normalized:
                return member
        # Back-compat for the upstream typo.
        if normalized == "preprend_first_segment":
            return cls.PREPEND_FIRST_SEGMENT
        raise ValueError(f"unknown initial prompt mode: {value!r}")


@runtime_checkable
class PromptStrategy(Protocol):
    """Provides the ``initial_prompt`` string passed to Whisper for each segment.

    Implementations must be picklable so they can cross process boundaries
    when parallel VAD is enabled.
    """

    def get_segment_prompt(
        self,
        segment_index: int,
        whisper_prompt: Optional[str],
        detected_language: Optional[str],
    ) -> Optional[str]: ...

    def on_segment_finished(
        self,
        segment_index: int,
        whisper_prompt: Optional[str],
        detected_language: Optional[str],
        result: dict,
    ) -> None: ...


def concat_prompts(a: Optional[str], b: Optional[str]) -> Optional[str]:
    """Join two prompts with a single space, dropping ``None``/empty parts."""
    if not a:
        return b
    if not b:
        return a
    return f"{a} {b}"
