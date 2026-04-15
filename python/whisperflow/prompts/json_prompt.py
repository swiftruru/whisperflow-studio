# Rewritten from faster-whisper-webui src/prompts/jsonPromptStrategy.py
# (Apache 2.0, (c) aadnk).  Changes: accept a parsed list *or* a raw JSON
# string, replace print-warning with a proper logger, added dataclass.
# See /NOTICES.md for license details.

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Optional, Union

from .base import concat_prompts

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class JsonPromptEntry:
    segment_index: int
    prompt: str
    format_prompt: bool = False


class JsonPromptStrategy:
    """Per-segment prompts driven by a JSON document.

    The JSON must be a list of entries of the form::

        [
            {"segment_index": 0, "prompt": "Hello, how are you?"},
            {"segment_index": 1, "prompt": "I'm doing well."},
            {"segment_index": 2, "prompt": "{0} Fine, thanks.", "format_prompt": true}
        ]

    When ``format_prompt`` is true, the entry's prompt is passed through
    ``str.format(whisper_prompt)`` so it can interpolate Whisper's own
    rolling prompt.
    """

    def __init__(self, source: Union[str, list]) -> None:
        entries = json.loads(source) if isinstance(source, str) else source
        self._entries: dict[int, JsonPromptEntry] = {}
        for raw in entries:
            entry = JsonPromptEntry(
                segment_index=int(raw["segment_index"]),
                prompt=raw["prompt"],
                format_prompt=bool(raw.get("format_prompt", False)),
            )
            self._entries[entry.segment_index] = entry

    def get_segment_prompt(
        self,
        segment_index: int,
        whisper_prompt: Optional[str],
        detected_language: Optional[str],
    ) -> Optional[str]:
        entry = self._entries.get(segment_index)
        if entry is None:
            _log.warning("no JSON prompt for segment %d, falling back to whisper's rolling prompt", segment_index)
            return whisper_prompt

        if entry.format_prompt:
            return entry.prompt.format(whisper_prompt or "")
        return concat_prompts(entry.prompt, whisper_prompt)

    def on_segment_finished(
        self,
        segment_index: int,
        whisper_prompt: Optional[str],
        detected_language: Optional[str],
        result: dict,
    ) -> None:
        return None
