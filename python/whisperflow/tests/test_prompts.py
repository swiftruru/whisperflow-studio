"""Unit tests for prompts/ strategies."""

from __future__ import annotations

import pytest

from whisperflow.prompts.base import InitialPromptMode, concat_prompts
from whisperflow.prompts.json_prompt import JsonPromptStrategy
from whisperflow.prompts.prepend import PrependPromptStrategy


def test_concat_prompts_drops_empties():
    assert concat_prompts("a", "b") == "a b"
    assert concat_prompts(None, "b") == "b"
    assert concat_prompts("a", None) == "a"
    assert concat_prompts(None, None) is None


def test_initial_prompt_mode_parse_accepts_typo():
    assert InitialPromptMode.parse("preprend_first_segment") is InitialPromptMode.PREPEND_FIRST_SEGMENT


def test_prepend_all_segments_applies_to_every_segment():
    strat = PrependPromptStrategy("CTX", InitialPromptMode.PREPEND_ALL_SEGMENTS)
    assert strat.get_segment_prompt(0, None, "en") == "CTX"
    assert strat.get_segment_prompt(5, "rolling", "en") == "CTX rolling"


def test_prepend_first_segment_only_prefixes_index_zero():
    strat = PrependPromptStrategy("CTX", InitialPromptMode.PREPEND_FIRST_SEGMENT)
    assert strat.get_segment_prompt(0, "rolling", "en") == "CTX rolling"
    assert strat.get_segment_prompt(1, "rolling", "en") == "rolling"


def test_prepend_rejects_unsupported_mode():
    with pytest.raises(ValueError):
        PrependPromptStrategy("CTX", InitialPromptMode.JSON_PROMPT_MODE)


def test_json_prompt_strategy_looks_up_by_index():
    doc = '[{"segment_index": 0, "prompt": "A"}, {"segment_index": 1, "prompt": "B"}]'
    strat = JsonPromptStrategy(doc)
    assert strat.get_segment_prompt(0, None, "en") == "A"
    assert strat.get_segment_prompt(1, "x", "en") == "B x"


def test_json_prompt_strategy_format_interpolates_rolling():
    doc = '[{"segment_index": 0, "prompt": "prev={0}", "format_prompt": true}]'
    strat = JsonPromptStrategy(doc)
    assert strat.get_segment_prompt(0, "hello", "en") == "prev=hello"


def test_json_prompt_strategy_falls_back_when_segment_missing():
    strat = JsonPromptStrategy("[]")
    assert strat.get_segment_prompt(0, "fallback", "en") == "fallback"
