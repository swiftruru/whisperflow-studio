"""Unit tests for config.py TranscribeConfig (de)serialisation."""

from __future__ import annotations

import json

from whisperflow.config import TranscribeConfig
from whisperflow.prompts.base import InitialPromptMode


def test_defaults_are_sane():
    cfg = TranscribeConfig()
    assert cfg.model == "large-v2"
    assert cfg.vad == "silero-vad"
    assert cfg.task == "transcribe"
    assert cfg.write_srt is True
    assert cfg.write_vtt is True


def test_from_dict_ignores_unknown_keys():
    cfg = TranscribeConfig.from_dict({"model": "tiny", "future_flag": "ignored"})
    assert cfg.model == "tiny"


def test_from_dict_parses_initial_prompt_mode():
    cfg = TranscribeConfig.from_dict({"initial_prompt_mode": "prepend_all_segments"})
    assert cfg.initial_prompt_mode is InitialPromptMode.PREPEND_ALL_SEGMENTS


def test_from_dict_splits_gpu_devices_string():
    cfg = TranscribeConfig.from_dict({"gpu_devices": "0,1, 2"})
    assert cfg.gpu_devices == ["0", "1", "2"]


def test_load_supports_flat_json(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"model": "medium", "language": "English"}))
    cfg = TranscribeConfig.load(path)
    assert cfg.model == "medium"
    assert cfg.language == "English"


def test_load_supports_nested_setting_wrapper(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"SETTING": {"model": "small"}, "OTHER": {}}))
    cfg = TranscribeConfig.load(path)
    assert cfg.model == "small"


def test_string_numerics_are_coerced_to_numbers():
    """Settings panel persists form inputs as strings; TranscribeConfig
    must coerce them to float/int so arithmetic doesn't blow up later."""
    cfg = TranscribeConfig.from_dict({
        "vad_max_merge_size": "30",
        "vad_merge_window": "5",
        "vad_padding": "1",
        "vad_prompt_window": "3",
        "beam_size": "5",
        "temperature": "0",
    })
    assert cfg.vad_max_merge_size == 30.0
    assert isinstance(cfg.vad_max_merge_size, float)
    assert cfg.vad_merge_window == 5.0
    assert cfg.vad_padding == 1.0
    assert cfg.vad_prompt_window == 3.0
    assert cfg.beam_size == 5
    assert isinstance(cfg.beam_size, int)
    assert cfg.temperature == 0.0


def test_blank_string_coerces_to_none_on_optional_fields():
    cfg = TranscribeConfig.from_dict({"language": "", "patience": ""})
    assert cfg.language is None
    assert cfg.patience is None


def test_bool_coercion_from_string_and_int():
    cfg = TranscribeConfig.from_dict({
        "verbose": "true",
        "condition_on_previous_text": "False",
        "write_srt": 1,
    })
    assert cfg.verbose is True
    assert cfg.condition_on_previous_text is False
    assert cfg.write_srt is True


def test_legacy_vad_argument_key_is_remapped():
    cfg = TranscribeConfig.from_dict({"vad_argument": "silero-vad-skip-gaps"})
    assert cfg.vad == "silero-vad-skip-gaps"


def test_legacy_vad_initial_prompt_mode_key_is_remapped():
    cfg = TranscribeConfig.from_dict({"vad_initial_prompt_mode": "prepend_all_segments"})
    assert cfg.initial_prompt_mode is InitialPromptMode.PREPEND_ALL_SEGMENTS


def test_to_dict_roundtrip():
    cfg = TranscribeConfig(model="tiny", language="English")
    data = cfg.to_dict()
    assert data["model"] == "tiny"
    assert data["initial_prompt_mode"] == InitialPromptMode.PREPEND_FIRST_SEGMENT.value
    restored = TranscribeConfig.from_dict(data)
    assert restored.model == "tiny"
    assert restored.language == "English"
