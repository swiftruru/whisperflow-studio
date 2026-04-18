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
from .events import STAGE_FAILED, STAGE_PREPARING, EventEmitter, emitter_for
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
    mode.add_argument("--scan-hf-cache", action="store_true", help="Scan the system HuggingFace cache for importable models and print a JSON report.")

    # When set, --download-model emits structured [WhisperFlowEvent] JSON
    # lines to stdout for every stage transition and progress tick so the
    # Electron main process can stream them to the renderer.  Without the
    # flag, --download-model behaves as before (single JSON line at end)
    # which preserves backwards compatibility with any external scripting.
    parser.add_argument(
        "--emit-events",
        action="store_true",
        help="Emit structured progress events during --download-model.",
    )

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
        return _cmd_download_model(args.download_model, args.models_dir, emit_events=args.emit_events)
    if args.delete_model:
        return _cmd_delete_model(args.delete_model, args.models_dir)
    if args.scan_hf_cache:
        return _cmd_scan_hf_cache(args.models_dir)

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


def _cmd_scan_hf_cache(models_dir: Optional[str]) -> int:
    """Report which registered models are available in the system HF cache
    but not yet installed in the managed models directory.  Users can then
    one-click import them via the Models tab; the normal download() flow
    picks up the fast-path automatically.
    """
    from .models.manager import default_hf_cache_dir, _resolve_source_files_dir, _has_required_files

    manager = ModelManager(Path(models_dir) if models_dir else None)
    installed_names = {m.entry.name for m in manager.list_installed()}
    cache_root = default_hf_cache_dir()

    available = []
    for entry in all_models():
        if entry.name in installed_names:
            continue
        source = cache_root / entry.local_dir_name
        snapshot = _resolve_source_files_dir(source)
        if snapshot and _has_required_files(snapshot):
            available.append({
                "name": entry.name,
                "repo_id": entry.repo_id,
                "approx_size_mb": entry.approx_size_mb,
            })

    print(json.dumps({
        "cache_dir": str(cache_root),
        "available": available,
    }, ensure_ascii=False, indent=2))
    return 0


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


def _cmd_download_model(name: str, models_dir: Optional[str], *, emit_events: bool = False) -> int:
    """Download a model and (optionally) stream structured progress events.

    When ``emit_events`` is True, each stage transition and progress tick
    is forwarded to stdout as a ``[WhisperFlowEvent]`` JSON line so the
    Electron main process can pipe it through ``parseRunnerEventLine``
    to its download-state store.  The final ``{"status": "downloaded"}``
    JSON is always printed at the end for backwards compatibility with
    external scripts that only want the summary.
    """
    manager = ModelManager(Path(models_dir) if models_dir else None)

    if emit_events:
        emitter = EventEmitter(source="whisperflow", file_name=name)

        def on_progress(event_type: str, payload: dict) -> None:
            if event_type == "stage":
                # Emit as a download-stage event; runner-event.js keeps
                # the `type` and `stage` fields as-is, and the meta dict
                # carries any auxiliary payload.
                emitter.emit(
                    "download-stage",
                    stage=str(payload.get("stage", "")),
                    extra=payload,
                )
            elif event_type == "progress":
                downloaded = int(payload.get("downloaded_bytes", 0) or 0)
                total = int(payload.get("total_bytes", 0) or 0)
                percent: Optional[float] = None
                if total > 0:
                    percent = round(min(100.0, (downloaded / total) * 100.0), 2)
                emitter.emit(
                    "download-progress",
                    progress=percent,
                    eta_seconds=payload.get("eta_seconds"),
                    extra={
                        "downloaded_bytes": downloaded,
                        "total_bytes": total,
                        "speed_bytes_per_sec": float(payload.get("speed_bytes_per_sec", 0) or 0),
                        "eta_seconds": float(payload.get("eta_seconds", 0) or 0),
                    },
                )

        try:
            path = manager.download(name, progress=on_progress)
        except Exception as err:  # pragma: no cover - defensive top-level
            _log.exception("model download failed")
            emitter.emit(
                "download-error",
                stage=STAGE_FAILED,
                message=str(err),
                extra={
                    "error_class": type(err).__name__,
                    "name": name,
                },
            )
            print(json.dumps({"status": "failed", "name": name, "error": str(err)}, ensure_ascii=False))
            return 1

        emitter.emit(
            "download-completed",
            message=f"{name} downloaded",
            extra={"name": name, "path": str(path)},
        )
        print(json.dumps({"status": "downloaded", "name": name, "path": str(path)}, ensure_ascii=False))
        return 0

    # Legacy single-line output for external scripting.
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
