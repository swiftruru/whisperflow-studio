"""Unit tests for languages.py lookups."""

from __future__ import annotations

import pytest

from whisperflow.languages import (
    get_language_by_code,
    get_language_by_name,
    get_language_names,
    resolve_language_code,
)


def test_lookup_by_code_case_insensitive():
    assert get_language_by_code("en").name == "English"
    assert get_language_by_code("ZH").name == "Chinese"


def test_lookup_by_name_accepts_aliases():
    assert get_language_by_name("Chinese").code == "zh"
    assert get_language_by_name("Mandarin").code == "zh"
    assert get_language_by_name("Flemish").code == "nl"


def test_resolve_language_code_passes_codes_through():
    assert resolve_language_code("en") == "en"
    assert resolve_language_code("Chinese") == "zh"


def test_resolve_language_code_none_for_empty():
    assert resolve_language_code(None) is None
    assert resolve_language_code("") is None


def test_resolve_language_code_raises_on_unknown():
    with pytest.raises(ValueError):
        resolve_language_code("Klingon")


def test_get_language_names_contains_whisper_languages():
    names = get_language_names()
    assert "English" in names
    assert "Chinese" in names
    assert "Japanese" in names
    assert len(names) > 90  # Whisper supports ~99
