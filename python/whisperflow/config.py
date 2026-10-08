# Rewritten from faster-whisper-webui src/config.py (Apache 2.0, (c) aadnk).
# Changes: replaced the 76-parameter ApplicationConfig (which mixed UI,
# server, auth, and diarization settings) with a focused TranscribeConfig
# dataclass that only holds options relevant to single-file transcription.
# JSON5 dependency gone (we use plain JSON), dropped model catalog (now in
# models/registry.py), dropped YouTube/auth/server fields.
# See /NOTICES.md for license details.

from __future__ import annotations

import json
import typing
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, ClassVar, Optional, get_type_hints

from .prompts.base import InitialPromptMode

# Whisper's defence against decoder repetition loops is a temperature
# LADDER, not a single value.  faster_whisper's generate_with_fallback
# iterates `options.temperatures`; when compression_ratio_threshold says a
# window came back too repetitive it tries the next rung, and if every
# rung fails it picks from `below_cr_threshold_results or all_results` --
# preferring any attempt that was not repetitive.
#
# A single value gives that selection exactly ONE candidate, so when that
# one decode loops, the loop is what gets returned: the detector fires and
# has nothing to choose instead.  Measured on a real 64-minute talk, one
# cue came back at a compression ratio of 7.78 against the 2.4 threshold,
# 1003 characters of the same sentence repeated.
#
# These are faster-whisper's own defaults.  Normal audio breaks out of the
# ladder on the first rung, so the extra rungs cost nothing until a window
# actually needs them.
DEFAULT_TEMPERATURE: tuple[float, ...] = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)


def parse_temperature(value: Any) -> tuple[float, ...]:
    """Normalise a temperature setting into a fallback ladder.

    Accepts what the three sources actually produce: a float from the CLI,
    a string from config.json (``"0.0"`` or ``"0.0, 0.2, 0.4"``), or an
    already-parsed sequence.  A bare value stays a one-rung ladder, so a
    config written before this existed keeps behaving exactly as it did.

    Anything unusable -- blank, non-numeric, out of Whisper's 0..1 range --
    is dropped, and a value that leaves nothing behind falls back to the
    default rather than handing faster-whisper an empty sequence, which
    would make generate_with_fallback skip its loop entirely and raise.
    """
    if value is None:
        return DEFAULT_TEMPERATURE
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        items: list[Any] = [value]
    elif isinstance(value, str):
        items = [part for part in value.replace(";", ",").split(",")]
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        return DEFAULT_TEMPERATURE

    out: list[float] = []
    for item in items:
        try:
            number = float(str(item).strip())
        except (TypeError, ValueError):
            continue
        if 0.0 <= number <= 1.0 and number not in out:
            out.append(number)
    if not out:
        return DEFAULT_TEMPERATURE
    # A lone 0.0 is the value every install carried before the ladder
    # existed, and it is not a meaningful setting in its own right: one
    # rung at 0.0 means "decode greedily and disable Whisper's repetition
    # defence", which is the defect, not a choice anyone made.  Greedy
    # decoding is still what happens first -- 0.0 remains rung one -- so
    # nothing is taken away by giving it somewhere to fall back to.
    if tuple(out) == (0.0,):
        return DEFAULT_TEMPERATURE
    return tuple(out)


# VAD strategy names accepted on the CLI and in config.json.  The two
# silero-vad variants differ only in how they treat non-speech regions
# (see :class:`whisperflow.vad.base.NonSpeechStrategy`).
VAD_CHOICES = (
    "none",
    "silero-vad",
    "silero-vad-skip-gaps",
    "silero-vad-expand-into-gaps",
    "periodic-vad",
)


@dataclass
class TranscribeConfig:
    """All tunables that drive a single transcription job.

    Consumers (the CLI, the Electron bridge) construct one of these either
    by parsing argv or by reading ``python/config/config.json`` and calling
    :meth:`from_dict`.  Unknown keys are ignored so existing config files
    don't need to be migrated in lock-step with schema changes.
    """

    # --- input / output ------------------------------------------------
    input_path: Optional[str] = None
    output_dir: Optional[str] = None
    output_name: Optional[str] = None
    write_srt: bool = True
    write_vtt: bool = True
    write_txt: bool = False
    write_json: bool = False
    # Characters per subtitle line, in the language's own unit.  Blank
    # means "decide by language": with subtitle_segmentation on that is 42
    # for Latin scripts and 16 for CJK (the published Netflix figures);
    # with it off, blank means no wrapping at all.
    max_line_width: Optional[int] = None
    # When an output file already exists at the target path:
    #   "overwrite"      — default: replace silently
    #   "skip"           — don't write; leave the existing file untouched
    #   "rename-suffix"  — write alongside as `<name>.1.srt`, `<name>.2.srt`, ...
    overwrite_policy: str = "overwrite"

    # --- model ---------------------------------------------------------
    model: str = "large-v2"
    models_dir: Optional[str] = None
    device: str = "auto"  # "auto", "cpu", "cuda"
    compute_type: str = "auto"  # faster-whisper: "float16", "int8", "int8_float16", ...

    # --- parallelism ---------------------------------------------------
    gpu_devices: list[str] = field(default_factory=list)
    cpu_parallelism: int = 1

    # --- VAD -----------------------------------------------------------
    vad: str = "silero-vad"  # see VAD_CHOICES
    vad_merge_window: float = 5.0
    vad_max_merge_size: float = 30.0
    vad_padding: float = 1.0
    vad_prompt_window: float = 3.0
    vad_periodic_duration: float = 30.0

    # --- speaker diarization -------------------------------------------
    # Off by default: enabling it downloads ~34 MB of models on first use
    # and turns on faster-whisper's word timestamps, which shifts segment
    # boundaries slightly.  See docs/specs/speaker-diarization.md.
    diarize: bool = False
    # 0 means "let the clustering threshold decide".  Mapped to sherpa-onnx's
    # num_clusters=-1 at the call site -- 0 is not a valid cluster count.
    diarize_num_speakers: int = 0
    diarize_threshold: float = 0.5
    # Repair sherpa-onnx's over-clustering after it runs.  On by default: at
    # 0.5 a 64-minute talk comes back as 60 "speakers" without it and 4 with
    # it.  Exposed as a switch because refinement masks diarize_threshold --
    # with it on, every threshold at or below the default gives the same
    # answer -- so a recording whose real speakers refinement merges needs a
    # way to get the raw clustering back.
    diarize_refine: bool = True
    # ``{n}`` is 1-based.  A template that fails to format falls back to the
    # default and logs a warning; see diarization.speaker_label().
    speaker_label_template: str = "Speaker {n}"

    # --- subtitle segmentation -----------------------------------------
    # Off by default, for the same reason diarization is: enabling it
    # turns on faster-whisper's word timestamps, and add_word_timestamps()
    # rewrites a segment's start/end from its first and last word.  So an
    # upgraded user's timestamps would move even where re-segmentation
    # never touched them.  See docs/specs/subtitle-segmentation.md.
    subtitle_segmentation: bool = False
    subtitle_max_lines: int = 2
    subtitle_max_duration: float = 7.0
    subtitle_min_duration: float = 5 / 6
    # Silence that ends a run: no cue ever spans a longer gap, nor two
    # speakers.  Joining content across Whisper's own segment boundaries
    # first is what stops a sentence being cut after "the".
    subtitle_run_gap: float = 1.0

    # --- Whisper decode options ---------------------------------------
    language: Optional[str] = None  # None = auto-detect
    task: str = "transcribe"  # or "translate"
    initial_prompt: Optional[str] = None
    initial_prompt_mode: InitialPromptMode = InitialPromptMode.PREPEND_FIRST_SEGMENT
    temperature: tuple[float, ...] = DEFAULT_TEMPERATURE
    beam_size: int = 5
    best_of: int = 5
    patience: Optional[float] = None
    length_penalty: Optional[float] = None
    suppress_tokens: Optional[str] = "-1"
    condition_on_previous_text: bool = True
    compression_ratio_threshold: float = 2.4
    logprob_threshold: float = -1.0
    no_speech_threshold: float = 0.6

    # --- misc ----------------------------------------------------------
    verbose: bool = False

    # -------- (de)serialisation ---------------------------------------

    # Legacy key names from the pre-rewrite config.json.  We map them to the
    # new field names so existing user configs don't need hand-migration.
    # ClassVar keeps this out of the dataclass field set.
    _KEY_ALIASES: ClassVar[dict[str, str]] = {
        "vad_argument": "vad",
        "vad_initial_prompt_mode": "initial_prompt_mode",
    }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TranscribeConfig":
        """Build from a plain dict, tolerating unknown keys and string enums.

        Crucially, this method **coerces** values to the field's declared
        type — Settings panel form inputs always serialise as strings, so
        without coercion ``"30"`` would land in a ``float`` field as a
        string and crash later when arithmetic is attempted.
        """
        if not data:
            return cls()

        allowed = {f.name for f in fields(cls)}
        type_hints = get_type_hints(cls)
        kwargs: dict[str, Any] = {}
        for raw_key, value in data.items():
            key = cls._KEY_ALIASES.get(raw_key, raw_key)
            if key not in allowed:
                continue
            if key == "diarize_refine" and (
                value is None or (isinstance(value, str) and not value.strip())
            ):
                # Blank or null means "unspecified", so let the dataclass
                # default (True) stand.  Every other bool here defaults to
                # False, where the generic coercion of blank -> False happens
                # to agree; this one is the exception, and getting it wrong
                # would silently disable speaker refinement and hand the user
                # 60 "speakers" on a long recording with no indication why.
                # Not hypothetical: configs written by this app have carried
                # `"diarize": null`.
                continue
            if key == "initial_prompt_mode" and value is not None:
                kwargs[key] = InitialPromptMode.parse(str(value))
            elif key == "gpu_devices" and isinstance(value, str):
                kwargs[key] = [part.strip() for part in value.split(",") if part.strip()]
            else:
                kwargs[key] = _coerce_value(value, type_hints.get(key))
        return cls(**kwargs)

    @classmethod
    def load(cls, path: Path) -> "TranscribeConfig":
        """Load from a JSON file.  Accepts either a flat dict or the
        ``{"SETTING": {...}}`` shape that Electron currently writes."""
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(raw, dict) and "SETTING" in raw and isinstance(raw["SETTING"], dict):
            raw = raw["SETTING"]
        return cls.from_dict(raw)

    def __post_init__(self) -> None:
        # _coerce_value leaves tuples alone, so a string straight out of
        # config.json arrives here unparsed.  This is the single point
        # where every source -- config file, CLI flag, direct construction
        # -- is normalised into a ladder.
        self.temperature = parse_temperature(self.temperature)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["initial_prompt_mode"] = self.initial_prompt_mode.value
        # Round-trips through config.json, which is a flat string map.
        data["temperature"] = ", ".join(str(value) for value in self.temperature)
        return data


def _coerce_value(value: Any, target_type: Any) -> Any:
    """Cast ``value`` to ``target_type`` where possible.

    Handles ``Optional[X]`` by unwrapping the non-``None`` arg.  Silently
    returns ``None`` for blank strings/``None`` on optional fields.  Leaves
    the value untouched when the target type is unknown, a list, or the
    input is already the right type — so we never clobber good data.
    """
    if target_type is None:
        return value

    origin = typing.get_origin(target_type)
    args = typing.get_args(target_type)

    # Unwrap Optional[X] -> X
    if origin is typing.Union:
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1:
            if value is None or value == "":
                return None
            return _coerce_value(value, non_none[0])
        return value

    # Lists / tuples: leave them alone (gpu_devices is handled separately)
    if origin in (list, tuple, set):
        return value

    try:
        if target_type is bool:
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)):
                return bool(value)
            if isinstance(value, str):
                return value.strip().lower() in ("true", "1", "yes", "on")
            return bool(value)

        if target_type is int:
            if isinstance(value, bool):
                return int(value)
            if isinstance(value, str) and value.strip() == "":
                return 0
            return int(float(value))  # "30" -> 30, 30.0 -> 30

        if target_type is float:
            if isinstance(value, str) and value.strip() == "":
                return 0.0
            return float(value)

        if target_type is str:
            if value is None:
                return ""
            return str(value)
    except (TypeError, ValueError):
        # If coercion fails, leave the original value — dataclass
        # construction will raise a clearer error than a swallowed one.
        return value

    return value
