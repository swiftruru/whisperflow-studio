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
    max_line_width: Optional[int] = None

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

    # --- Whisper decode options ---------------------------------------
    language: Optional[str] = None  # None = auto-detect
    task: str = "transcribe"  # or "translate"
    initial_prompt: Optional[str] = None
    initial_prompt_mode: InitialPromptMode = InitialPromptMode.PREPEND_FIRST_SEGMENT
    temperature: float = 0.0
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

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["initial_prompt_mode"] = self.initial_prompt_mode.value
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
