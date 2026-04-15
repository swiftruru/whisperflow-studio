# Rewritten from faster-whisper-webui cli.py (Apache 2.0, (c) aadnk).
# Changes: argparse surface is much smaller (no YouTube, no diarization,
# no parallel-auto-detect options, no WebUI flags), config is driven by
# WhisperFlow Studio's own ``python/config/config.json`` file when called
# from Electron, and the script exposes three sub-commands:
#   (default) transcribe a single file
#   --list-models       print built-in models and which are installed
#   --download-model    download a single model into the managed dir
#   --delete-model      remove an installed model
# See /NOTICES.md for license details.

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Optional

from .config import VAD_CHOICES, TranscribeConfig
from .events import STAGE_FAILED, STAGE_PREPARING, emitter_for
from .models.manager import ModelManager, default_models_dir
from .models.registry import all_models, model_names
from .prompts.base import InitialPromptMode
from .transcriber import Transcriber

_log = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="whisperflow",
        description="WhisperFlow Studio transcription CLI (faster-whisper backend).",
    )

    # --- operation mode ------------------------------------------------
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--list-models", action="store_true", help="List built-in models and installation status.")
    mode.add_argument("--download-model", metavar="NAME", help="Download the named model into the managed models directory.")
    mode.add_argument("--delete-model", metavar="NAME", help="Delete the named model from the managed models directory.")

    # --- input / output ------------------------------------------------
    parser.add_argument("input", nargs="?", help="Path to the input audio/video file.")
    parser.add_argument("--config-file", help="Load defaults from a JSON config file.")
    parser.add_argument("--output-dir", help="Directory to write subtitle files to (default: alongside input).")
    parser.add_argument("--output-name", help="Base name for output files (default: input file stem).")
    parser.add_argument("--no-srt", action="store_true", help="Do not write an SRT file.")
    parser.add_argument("--no-vtt", action="store_true", help="Do not write a VTT file.")
    parser.add_argument("--write-txt", action="store_true", help="Also write a plain-text transcript.")
    parser.add_argument("--write-json", action="store_true", help="Also write the raw segment JSON.")
    parser.add_argument("--max-line-width", type=int, help="Soft-wrap subtitle lines at this character width.")

    # --- model ---------------------------------------------------------
    parser.add_argument("--model", default="large-v2", choices=model_names(), help="Whisper model to use.")
    parser.add_argument("--models-dir", help="Override the managed models directory.")
    parser.add_argument("--device", default="auto", help="'auto', 'cpu', 'cuda'.")
    parser.add_argument("--compute-type", default="auto", help="faster-whisper compute_type (float16, int8, int8_float16, ...).")
    parser.add_argument("--gpu-devices", default="", help="Comma-separated CUDA device IDs for multi-GPU.")
    parser.add_argument("--cpu-parallelism", type=int, default=1, help="Number of CPU processes for parallel VAD.")

    # --- VAD -----------------------------------------------------------
    parser.add_argument("--vad", default="silero-vad", choices=VAD_CHOICES, help="VAD strategy.")
    parser.add_argument("--vad-merge-window", type=float, default=5.0)
    parser.add_argument("--vad-max-merge-size", type=float, default=30.0)
    parser.add_argument("--vad-padding", type=float, default=1.0)
    parser.add_argument("--vad-prompt-window", type=float, default=3.0)

    # --- whisper decode -----------------------------------------------
    parser.add_argument("--language", help="Language name or ISO code. Omit to auto-detect.")
    parser.add_argument("--task", default="transcribe", choices=("transcribe", "translate"))
    parser.add_argument("--initial-prompt", help="Initial prompt passed to Whisper.")
    parser.add_argument(
        "--initial-prompt-mode",
        default="prepend_first_segment",
        choices=[m.value for m in InitialPromptMode],
    )
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--verbose", action="store_true")

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    args = build_parser().parse_args(argv)

    # --- sub-commands: model management -------------------------------

    if args.list_models:
        return _cmd_list_models(args.models_dir)
    if args.download_model:
        return _cmd_download_model(args.download_model, args.models_dir)
    if args.delete_model:
        return _cmd_delete_model(args.delete_model, args.models_dir)

    # --- default: transcribe a file -----------------------------------

    config = _build_transcribe_config(args)
    emitter = emitter_for(config.input_path)

    if not config.input_path:
        emitter.error("no input file specified", extra={"reason": "missing_input"})
        return 2

    try:
        transcriber = Transcriber(config, emitter=emitter)
        outputs = transcriber.run()
    except FileNotFoundError as err:
        emitter.error(str(err), extra={"reason": "missing_input"})
        return 2
    except Exception as err:  # pragma: no cover - defensive top-level
        _log.exception("transcription failed")
        emitter.error(str(err), extra={"reason": type(err).__name__})
        return 1

    _log.info("wrote SRT: %s", outputs.srt_path)
    return 0


# --- model management sub-commands ------------------------------------


def _cmd_list_models(models_dir: Optional[str]) -> int:
    manager = ModelManager(Path(models_dir) if models_dir else None)
    installed_names = {m.entry.name for m in manager.list_installed()}
    rows = []
    for entry in all_models():
        rows.append(
            {
                "name": entry.name,
                "repo_id": entry.repo_id,
                "approx_size_mb": entry.approx_size_mb,
                "description": entry.description,
                "installed": entry.name in installed_names,
            }
        )
    print(json.dumps({"models_dir": str(manager.models_dir), "models": rows}, ensure_ascii=False, indent=2))
    return 0


def _cmd_download_model(name: str, models_dir: Optional[str]) -> int:
    manager = ModelManager(Path(models_dir) if models_dir else None)
    path = manager.download(name)
    print(json.dumps({"status": "downloaded", "name": name, "path": str(path)}, ensure_ascii=False))
    return 0


def _cmd_delete_model(name: str, models_dir: Optional[str]) -> int:
    manager = ModelManager(Path(models_dir) if models_dir else None)
    removed = manager.delete(name)
    print(json.dumps({"status": "deleted" if removed else "not_installed", "name": name}, ensure_ascii=False))
    return 0


# --- config building --------------------------------------------------


def _build_transcribe_config(args: argparse.Namespace) -> TranscribeConfig:
    """Merge a config file (if any) with CLI overrides.

    Precedence (highest first): explicit CLI arguments > config file > dataclass defaults.
    """
    base = TranscribeConfig.load(Path(args.config_file)) if args.config_file else TranscribeConfig()

    if args.input is not None:
        base.input_path = args.input
    if args.output_dir is not None:
        base.output_dir = args.output_dir
    if args.output_name is not None:
        base.output_name = args.output_name

    if args.no_srt:
        base.write_srt = False
    if args.no_vtt:
        base.write_vtt = False
    if args.write_txt:
        base.write_txt = True
    if args.write_json:
        base.write_json = True
    if args.max_line_width is not None:
        base.max_line_width = args.max_line_width

    base.model = args.model
    if args.models_dir:
        base.models_dir = args.models_dir
    elif not base.models_dir:
        base.models_dir = str(default_models_dir())

    base.device = args.device
    base.compute_type = args.compute_type
    base.gpu_devices = [d.strip() for d in args.gpu_devices.split(",") if d.strip()]
    base.cpu_parallelism = args.cpu_parallelism

    base.vad = args.vad
    base.vad_merge_window = args.vad_merge_window
    base.vad_max_merge_size = args.vad_max_merge_size
    base.vad_padding = args.vad_padding
    base.vad_prompt_window = args.vad_prompt_window

    if args.language is not None:
        base.language = args.language
    base.task = args.task
    if args.initial_prompt is not None:
        base.initial_prompt = args.initial_prompt
    base.initial_prompt_mode = InitialPromptMode.parse(args.initial_prompt_mode)
    base.beam_size = args.beam_size
    base.temperature = args.temperature
    base.verbose = args.verbose

    return base


if __name__ == "__main__":
    sys.exit(main())
