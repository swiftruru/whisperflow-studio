"""Unit tests for config.py TranscribeConfig (de)serialisation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from whisperflow.config import TranscribeConfig
from whisperflow.prompts.base import InitialPromptMode


def test_defaults_are_sane():
    cfg = TranscribeConfig()
    assert cfg.model == "large-v2"
    assert cfg.vad == "silero-vad"
    assert cfg.task == "transcribe"
    assert cfg.write_srt is True
    assert cfg.write_vtt is True
    # On by default since v1.17.3.  Both of its costs are visible rather
    # than silent: the ~34 MB download gets its own progress stage, and
    # the extra pass is about 7% of a run.
    assert cfg.diarize is True
    assert cfg.diarize_num_speakers == 0
    assert cfg.diarize_threshold == 0.5
    assert cfg.speaker_label_template == "Speaker {n}"
    # On by default since v1.17.3.  Whisper's own segments are not
    # subtitles -- on a measured 64-minute talk, 7% ran past the 7-second
    # norm and the longest was 29.9s.  It costs word timestamps, which
    # diarization (also on) already pays for.
    assert cfg.subtitle_segmentation is True
    assert cfg.subtitle_max_lines == 2
    assert cfg.subtitle_max_duration == 7.0
    assert cfg.subtitle_min_duration == 5 / 6
    assert cfg.subtitle_run_gap == 1.0


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
    # temperature is no longer a plain number: it is a fallback ladder, and
    # a lone 0.0 -- the pre-ladder default -- is read as "unset".  See the
    # ladder tests at the bottom of this file.
    assert cfg.temperature == (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)


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
    assert setting["diarize"] == "True"
    assert TranscribeConfig.from_dict(setting).diarize is True


# --- subtitle segmentation fields ----------------------------------------


def test_subtitle_segmentation_flag_coercion():
    for raw, expected in (("False", False), ("True", True), ("0", False), (1, True)):
        cfg = TranscribeConfig.from_dict({"subtitle_segmentation": raw})
        assert cfg.subtitle_segmentation is expected, raw


def test_subtitle_numeric_fields_coerce_from_strings():
    cfg = TranscribeConfig.from_dict(
        {
            "subtitle_max_lines": "3",
            "subtitle_max_duration": "6.5",
            "subtitle_min_duration": "0.833",
            "subtitle_run_gap": "1.5",
        }
    )
    assert cfg.subtitle_max_lines == 3
    assert isinstance(cfg.subtitle_max_lines, int)
    assert cfg.subtitle_max_duration == 6.5
    assert cfg.subtitle_min_duration == 0.833
    assert cfg.subtitle_run_gap == 1.5


def test_blank_subtitle_fields_coerce_to_zero_which_is_why_options_clamp():
    # A blank number input is the realistic failure: a bare int becomes 0
    # and a bare float becomes 0.0.  max_lines=0 would make every cue
    # infeasible, so SegmentationOptions.__post_init__ has to clamp --
    # this test records why that clamp exists.
    cfg = TranscribeConfig.from_dict(
        {
            "subtitle_max_lines": "",
            "subtitle_max_duration": "",
            "subtitle_min_duration": "",
            "subtitle_run_gap": "",
        }
    )
    assert cfg.subtitle_max_lines == 0
    assert cfg.subtitle_max_duration == 0.0
    assert cfg.subtitle_min_duration == 0.0
    assert cfg.subtitle_run_gap == 0.0

    from whisperflow.subtitles.segmentation import SegmentationOptions

    options = SegmentationOptions(
        max_lines=cfg.subtitle_max_lines,
        max_duration=cfg.subtitle_max_duration,
        min_duration=cfg.subtitle_min_duration,
        run_gap=cfg.subtitle_run_gap,
    )
    assert options.max_lines == 2
    assert options.max_duration == 7.0


def test_max_line_width_still_means_unset_when_blank():
    # Optional[int] + "" short-circuits to None, which is what keeps
    # "blank = decide by language" reachable from the Settings panel.
    assert TranscribeConfig.from_dict({"max_line_width": ""}).max_line_width is None
    assert TranscribeConfig.from_dict({"max_line_width": "42"}).max_line_width == 42


def test_segmentation_fields_round_trip_through_to_dict():
    cfg = TranscribeConfig(subtitle_segmentation=True, subtitle_max_lines=3)
    data = cfg.to_dict()
    assert data["subtitle_segmentation"] is True
    assert data["subtitle_max_lines"] == 3
    restored = TranscribeConfig.from_dict(data)
    assert restored.subtitle_segmentation is True
    assert restored.subtitle_max_lines == 3


def test_example_config_template_carries_the_segmentation_keys():
    template_path = Path(__file__).resolve().parents[2] / "config" / "config.example.json"
    setting = json.loads(template_path.read_text(encoding="utf-8"))["SETTING"]
    for key in (
        "subtitle_segmentation",
        "subtitle_max_lines",
        "subtitle_max_duration",
        "subtitle_min_duration",
        "subtitle_run_gap",
    ):
        assert key in setting, key
    # The Settings UI infers the widget from the value, so these exact
    # string forms are what make a checkbox a checkbox.
    assert setting["subtitle_segmentation"] == "True"
    assert setting["subtitle_max_lines"] == "2"
    # Blank keeps "decide by language" reachable; a numeric seed would
    # turn the control into a number input and make it unreachable.
    assert setting["max_line_width"] == ""
    assert TranscribeConfig.from_dict(setting).subtitle_segmentation is True


def test_diarize_refine_defaults_to_on():
    assert TranscribeConfig().diarize_refine is True


def test_diarize_refine_keeps_its_default_when_blank_or_null():
    # Every other bool field defaults to False, so the generic blank -> False
    # coercion agrees with its default.  This one defaults to True, and a
    # config written with a null -- which this app has done for `diarize` --
    # must not silently disable refinement.
    for value in ("", "   ", None):
        assert TranscribeConfig.from_dict({"diarize_refine": value}).diarize_refine is True


def test_diarize_refine_can_still_be_turned_off_explicitly():
    for value in ("False", "false", "0", "no", False):
        assert TranscribeConfig.from_dict({"diarize_refine": value}).diarize_refine is False


# --- the temperature fallback ladder -----------------------------------
#
# Whisper's defence against decoder repetition loops is a ladder, not a
# single value: faster_whisper's generate_with_fallback iterates
# `options.temperatures` and, when every rung fails, selects from
# `below_cr_threshold_results or all_results`.  One rung gives that
# selection one candidate, so a repetitive decode is returned because
# there is nothing else to return.  Measured on a real 64-minute talk:
# one cue at compression ratio 7.78 against the 2.4 threshold.


def test_the_default_is_a_ladder_not_a_single_value():
    assert TranscribeConfig().temperature == (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)


def test_a_ladder_string_from_the_config_file_is_parsed():
    assert TranscribeConfig.from_dict(
        {"temperature": "0.0, 0.3, 0.7"}
    ).temperature == (0.0, 0.3, 0.7)


@pytest.mark.parametrize("raw", ["0.0,0.3", "0.0 , 0.3", "0.0; 0.3"])
def test_separators_and_spacing_are_tolerated(raw):
    assert TranscribeConfig.from_dict({"temperature": raw}).temperature == (0.0, 0.3)


def test_a_deliberate_single_value_is_respected():
    # One rung really does mean "no fallback".  That is a legitimate, if
    # unwise, choice and the parser must not override it.
    assert TranscribeConfig.from_dict({"temperature": "0.3"}).temperature == (0.3,)


def test_a_lone_zero_is_upgraded_to_the_ladder():
    # 0.0 alone is the value every install carried before the ladder
    # existed.  It is not a setting anyone chose, it is the defect, and
    # leaving it alone would mean the fix reaches new installs only.
    # Greedy decoding is still what happens first, so nothing is lost.
    assert TranscribeConfig.from_dict(
        {"temperature": "0.0"}
    ).temperature == (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)


@pytest.mark.parametrize("raw", ["", None, "abc", "   ", [], "5.0", "-1"])
def test_unusable_values_fall_back_to_the_ladder(raw):
    # Never an empty sequence: generate_with_fallback would skip its loop
    # and leave decode_result unbound.
    assert TranscribeConfig.from_dict(
        {"temperature": raw}
    ).temperature == (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)


def test_out_of_range_rungs_are_dropped_and_the_rest_kept():
    assert TranscribeConfig.from_dict(
        {"temperature": "0.0, 5.0, -1, 0.4"}
    ).temperature == (0.0, 0.4)


def test_duplicate_rungs_collapse():
    assert TranscribeConfig.from_dict(
        {"temperature": "0.2, 0.2, 0.4"}
    ).temperature == (0.2, 0.4)


def test_a_float_from_the_cli_becomes_a_one_rung_ladder():
    assert TranscribeConfig(temperature=0.3).temperature == (0.3,)


def test_a_sequence_passed_directly_is_kept():
    assert TranscribeConfig(temperature=[0.0, 0.5]).temperature == (0.0, 0.5)


def test_the_ladder_round_trips_through_to_dict():
    # config.json is a flat string map, so to_dict has to render it back.
    rendered = TranscribeConfig().to_dict()["temperature"]
    assert rendered == "0.0, 0.2, 0.4, 0.6, 0.8, 1.0"
    assert TranscribeConfig.from_dict({"temperature": rendered}).temperature \
        == TranscribeConfig().temperature


def test_the_shipped_example_config_carries_the_ladder():
    # config.json is gitignored, so the example is what reaches a release.
    import json
    from pathlib import Path
    example = json.loads(
        (Path(__file__).resolve().parents[3] / "python/config/config.example.json")
        .read_text(encoding="utf-8")
    )
    assert TranscribeConfig.from_dict(example["SETTING"]).temperature \
        == (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)


# --- the translation profiles we ship ----------------------------------
#
# Profiles are directories under python/config/ holding their own
# config.json, and .gitignore excludes them so a user's own profiles are
# never committed -- these two are re-included by name because they are
# part of the repo.  A release ships them through electron-builder's
# `python/**/*` extraResources, so if they stop being tracked they stop
# reaching users, silently.

PROFILE_DIR = Path(__file__).resolve().parents[3] / "python" / "config"


@pytest.mark.parametrize("name", ["EN-Translate", "TW-Translate"])
def test_the_shipped_translation_profiles_exist(name):
    assert (PROFILE_DIR / name / "config.json").is_file()


@pytest.mark.parametrize(
    "name,language,line_width",
    [("EN-Translate", "English", 80), ("TW-Translate", "Chinese", 30)],
)
def test_a_translation_profile_widens_the_cue_so_a_clause_fits(name, language, line_width):
    # The point of these: a cue wide enough to hold a whole clause, so an
    # external translator sees a sentence rather than a fragment.  Measured
    # on a 5-minute slice of a real lecture, 80 characters per line takes
    # the share of cues ending at a sentence or comma from 87.5% to 100%
    # and fragments of four words or fewer from 3.8% to zero.
    #
    # The Chinese width is derived rather than measured: 42 -> 80 is the
    # same 1.9x relaxation applied to the CJK norm of 16.  There was no
    # Chinese material long enough to measure on.
    cfg = TranscribeConfig.load(PROFILE_DIR / name / "config.json")
    assert cfg.language == language
    assert cfg.subtitle_segmentation is True
    assert cfg.max_line_width == line_width
    assert cfg.subtitle_max_duration == 12.0
    assert cfg.subtitle_max_lines == 2


@pytest.mark.parametrize("name", ["EN-Translate", "TW-Translate"])
def test_a_translation_profile_is_a_complete_config(name):
    # Written in full rather than as a diff, so loading one does not depend
    # on what the defaults happen to be that release.
    shipped = json.loads(
        (PROFILE_DIR / name / "config.json").read_text(encoding="utf-8")
    )["SETTING"]
    template = json.loads(
        (PROFILE_DIR / "config.example.json").read_text(encoding="utf-8")
    )["SETTING"]
    assert set(shipped) == set(template)
