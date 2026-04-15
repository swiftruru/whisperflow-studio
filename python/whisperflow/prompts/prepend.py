# Rewritten from faster-whisper-webui src/prompts/prependPromptStrategy.py
# (Apache 2.0, (c) aadnk).  Changes: uses Protocol-based PromptStrategy,
# no-op on_segment_finished, cleaner validation.  See /NOTICES.md.

from __future__ import annotations

from typing import Optional

from .base import InitialPromptMode, concat_prompts


class PrependPromptStrategy:
    """Prepend a single initial prompt to all segments, or just the first.

    This covers the two simple modes from the upstream project:
    ``PREPEND_ALL_SEGMENTS`` and ``PREPEND_FIRST_SEGMENT``.  JSON-driven
    per-segment prompts are handled by :class:`JsonPromptStrategy`.
    """

    def __init__(self, initial_prompt: Optional[str], mode: InitialPromptMode) -> None:
        if mode not in (InitialPromptMode.PREPEND_ALL_SEGMENTS, InitialPromptMode.PREPEND_FIRST_SEGMENT):
            raise ValueError(f"PrependPromptStrategy does not support mode {mode}")
        self._initial_prompt = initial_prompt
        self._mode = mode

    def get_segment_prompt(
        self,
        segment_index: int,
        whisper_prompt: Optional[str],
        detected_language: Optional[str],
    ) -> Optional[str]:
        if self._mode is InitialPromptMode.PREPEND_ALL_SEGMENTS:
            return concat_prompts(self._initial_prompt, whisper_prompt)
        # PREPEND_FIRST_SEGMENT
        if segment_index == 0:
            return concat_prompts(self._initial_prompt, whisper_prompt)
        return whisper_prompt

    def on_segment_finished(
        self,
        segment_index: int,
        whisper_prompt: Optional[str],
        detected_language: Optional[str],
        result: dict,
    ) -> None:
        return None
