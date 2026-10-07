"""Unit tests for config.py TranscribeConfig (de)serialisation."""

from __future__ import annotations

import json
from pathlib import Path

from whisperflow.config import TranscribeConfig
from whisperflow.prompts.base import InitialPromptMode


def test_defaults_are_sane():
    cfg = TranscribeConfig()
    assert cfg.model == "large-v2"
    assert cfg.vad == "silero-vad"
    assert cfg.task == "transcribe"
    assert cfg.write_srt is True
    assert cfg.write_vtt is True
    # Diarization must stay off by default: it downloads ~34 MB on first
    # use and changes the Whisper decode options.
    assert cfg.diarize is False
    assert cfg.diarize_num_speakers == 0
    assert cfg.diarize_threshold == 0.5
    assert cfg.speaker_label_template == "Speaker {n}"


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


# --- speaker diarization fields ------------------------------------------
#
# config.example.json stores every one of these as a *string* so the
# auto-generated Settings UI picks the right widget ("False" -> checkbox,
# "0" / "0.5" -> number input).  These tests pin the coercion that turns
# those strings back into real Python values.


def test_diarize_flag_coercion():
    for raw, expected in (
        ("False", False),
        ("True", True),
        ("true", True),
        ("0", False),
        ("0.0", False),
        (0, False),
        (1, True),
    ):
        cfg = TranscribeConfig.from_dict({"diarize": raw})
        assert cfg.diarize is expected, raw


def test_diarize_num_speakers_coercion():
    # Blank means "unset", which _coerce_value turns into 0 -- the same
    # value as an explicit 0, and both mean "decide automatically".
    assert TranscribeConfig.from_dict({"diarize_num_speakers": "0"}).diarize_num_speakers == 0
    assert TranscribeConfig.from_dict({"diarize_num_speakers": ""}).diarize_num_speakers == 0
    assert TranscribeConfig.from_dict({"diarize_num_speakers": "4"}).diarize_num_speakers == 4
    assert TranscribeConfig.from_dict({"diarize_num_speakers": 4.0}).diarize_num_speakers == 4
    assert isinstance(
        TranscribeConfig.from_dict({"diarize_num_speakers": "4"}).diarize_num_speakers, int
    )


def test_diarize_threshold_coercion():
    cfg = TranscribeConfig.from_dict({"diarize_threshold": "0.45"})
    assert cfg.diarize_threshold == 0.45
    assert isinstance(cfg.diarize_threshold, float)
    assert TranscribeConfig.from_dict({"diarize_threshold": ""}).diarize_threshold == 0.0


def test_speaker_label_template_none_becomes_empty_string():
    # _coerce_value maps None onto "" for str fields, which is why
    # diarization.speaker_label() has to treat a blank template as
    # "fall back to the default" rather than trusting it.
    assert TranscribeConfig.from_dict({"speaker_label_template": None}).speaker_label_template == ""
    cfg = TranscribeConfig.from_dict({"speaker_label_template": "講者 {n}"})
    assert cfg.speaker_label_template == "講者 {n}"


def test_example_config_template_carries_the_diarization_keys():
    # python/config/config.json is gitignored, so config.example.json is the
    # only file that ships new defaults -- and config-manager.js merges it
    # into an existing user's config on read.  A key missing here never
    # reaches config.json, and the Settings UI only renders keys that are
    # actually present in config.json.
    template_path = Path(__file__).resolve().parents[2] / "config" / "config.example.json"
    setting = json.loads(template_path.read_text(encoding="utf-8"))["SETTING"]
    for key in ("diarize", "diarize_num_speakers", "speaker_label_template", "diarize_threshold"):
        assert key in setting, key
    # The widget the Settings UI infers depends on these exact literals.
    assert setting["diarize"] == "False"
    assert TranscribeConfig.from_dict(setting).diarize is False
