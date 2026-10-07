# Rewritten from faster-whisper-webui app.py's WhisperTranscriber class
# (Apache 2.0, (c) aadnk).  Changes: dropped all Gradio glue, zip output,
# URL/microphone ingest, diarization, multi-file handling, VadOptions
# bundle class, and the 40-character CJK line-width override.  The
# remaining class is a single orchestrator for "given a config and a
# local file, produce SRT/VTT/TXT outputs and emit progress events".
# See /NOTICES.md for license details.

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .config import TranscribeConfig
from .events import (
    STAGE_COMPLETED,
    STAGE_DIARIZING,
    STAGE_LOADING_MODEL,
    STAGE_LOADING_VAD,
    STAGE_PREPARING,
    STAGE_SEGMENTING,
    STAGE_TRANSCRIBING,
    STAGE_WRITING_SUBTITLE,
    EventEmitter,
    emitter_for,
)
from .models.cache import GLOBAL_MODEL_CACHE
from .models.faster_whisper_backend import FasterWhisperBackend
from .models.manager import ModelManager, is_silero_vad_cached
from .models.whisper_container import TranscribeResult
from .progress import NullProgressListener, ProgressListener
from .prompts.base import InitialPromptMode
from .prompts.json_prompt import JsonPromptStrategy
from .prompts.prepend import PrependPromptStrategy
from .subtitles.writers import write_srt, write_txt, write_vtt
from .vad.base import (
    AbstractVadTranscription,
    NonSpeechStrategy,
    PeriodicTranscriptionConfig,
    TranscriptionConfig,
    load_audio,
)
from .vad.parallel import ParallelContext, ParallelVadTranscription
from .vad.periodic import PeriodicVad
from .vad.silero import SileroVad

_log = logging.getLogger(__name__)


@dataclass
class TranscribeOutputs:
    """Paths written to disk, plus the in-memory result dict."""

    srt_path: Optional[Path]
    vtt_path: Optional[Path]
    txt_path: Optional[Path]
    json_path: Optional[Path]
    result: TranscribeResult


class Transcriber:
    """High-level entry point for a single-file transcription job.

    Typical use from the CLI::

        transcriber = Transcriber(config)
        outputs = transcriber.run()
    """

    def __init__(
        self,
        config: TranscribeConfig,
        *,
        emitter: Optional[EventEmitter] = None,
        progress_listener: Optional[ProgressListener] = None,
    ) -> None:
        self._config = config
        self._emitter = emitter or emitter_for(config.input_path)
        self._listener = progress_listener or NullProgressListener()
        self._model_manager = ModelManager(Path(config.models_dir) if config.models_dir else None)
        self._vad_model: Optional[AbstractVadTranscription] = None
        self._gpu_context: Optional[ParallelContext] = None
        self._cpu_context: Optional[ParallelContext] = None

    # --- public API ----------------------------------------------------

    def run(self) -> TranscribeOutputs:
        """Execute the full pipeline and return the on-disk output paths."""
        cfg = self._config
        if not cfg.input_path:
            raise ValueError("TranscribeConfig.input_path is required")

        input_path = Path(cfg.input_path)
        if not input_path.is_file():
            raise FileNotFoundError(f"input file does not exist: {input_path}")

        self._model_manager.ensure_dirs()

        self._emitter.stage(
            STAGE_PREPARING,
            message="Preparing model and VAD",
            message_key="events:stage.preparing",
            progress=5,
        )

        backend = self._build_backend()

        self._emitter.stage(
            STAGE_LOADING_MODEL,
            message=f"Loading model {cfg.model}",
            message_key="events:stage.loadingModel",
            message_params={"model": cfg.model},
            progress=15,
        )
        backend.get_model()  # force eager load so subsequent progress is VAD time only

        prompt_strategy = self._build_prompt_strategy()
        decode_options = self._build_decode_options()
        callback = backend.create_callback(
            language=cfg.language,
            task=cfg.task,
            prompt_strategy=prompt_strategy,
            **decode_options,
        )

        self._emitter.stage(
            STAGE_TRANSCRIBING,
            message="Running VAD and Whisper",
            message_key="events:stage.transcribing",
            progress=30,
        )
        perf_start = time.perf_counter()
        result = self._run_vad(str(input_path), callback)
        elapsed = time.perf_counter() - perf_start
        _log.info("whisper + VAD took %.2fs", elapsed)

        if cfg.diarize:
            # After _run_vad, so the segments are already on the global
            # timeline and share one clock with the speaker turns; before
            # _write_outputs, so the writers see speaker_label.
            self._run_diarization(result, input_path)

        if cfg.subtitle_segmentation:
            # After diarization, not before: cues are built from runs of a
            # single speaker, so a word has to know who said it before it
            # can be sized.  The reverse order would let assign_speakers
            # re-split the sized cues at speaker boundaries and overwrite
            # their word-accurate edges, which is the whole point of the
            # feature.
            self._run_segmentation(result)

        self._emitter.stage(
            STAGE_WRITING_SUBTITLE,
            message="Writing subtitle files",
            message_key="events:stage.writingSubtitle",
            progress=92,
        )
        outputs = self._write_outputs(result, input_path)

        _log.info(
            "\033[1;32m✔ Transcription completed in %.2fs\033[0m",
            elapsed,
        )
        self._emitter.completed()
        return outputs

    def clear_cache(self) -> None:
        GLOBAL_MODEL_CACHE.clear()
        self._vad_model = None

    # --- model / VAD wiring --------------------------------------------

    def _build_backend(self) -> FasterWhisperBackend:
        cfg = self._config
        model_path = self._model_manager.resolve_model_path(cfg.model)
        return FasterWhisperBackend(
            model_path,
            device=cfg.device,
            compute_type=cfg.compute_type,
            model_dir=str(self._model_manager.models_dir),
            cache=GLOBAL_MODEL_CACHE,
        )

    def _build_prompt_strategy(self):
        cfg = self._config
        if cfg.initial_prompt_mode is InitialPromptMode.JSON_PROMPT_MODE:
            return JsonPromptStrategy(cfg.initial_prompt or "[]")
        return PrependPromptStrategy(cfg.initial_prompt, cfg.initial_prompt_mode)

    def _build_decode_options(self) -> dict:
        cfg = self._config
        options = {
            "temperature": cfg.temperature,
            "beam_size": cfg.beam_size,
            "best_of": cfg.best_of,
            "patience": cfg.patience,
            "length_penalty": cfg.length_penalty,
            "suppress_tokens": cfg.suppress_tokens,
            "condition_on_previous_text": cfg.condition_on_previous_text,
            "compression_ratio_threshold": cfg.compression_ratio_threshold,
            "log_prob_threshold": cfg.logprob_threshold,
            "no_speech_threshold": cfg.no_speech_threshold,
            "verbose": cfg.verbose,
        }

        if cfg.diarize or cfg.subtitle_segmentation:
            # Word timestamps are what make per-word speaker assignment --
            # and therefore mid-segment speaker splits -- possible, and
            # they are the whole basis of subtitle re-segmentation.
            #
            # Still gated, because switching them on is NOT a pure
            # addition: faster-whisper's add_word_timestamps() rewrites a
            # segment's start/end from its first/last word, and changes how
            # the decode window advances.  Leaving the key out entirely
            # means faster-whisper's own default (False) applies, so with
            # both features off the decode is bit-for-bit what it was.
            options["word_timestamps"] = True

        return options

    # --- speaker diarization -------------------------------------------

    def _run_diarization(self, result: TranscribeResult, input_path: Path) -> None:
        """Label every segment in ``result`` with a speaker, in place.

        Progress occupies the 50..90 band, which is otherwise empty: the
        Whisper run reports 35 and subtitle writing reports 92, and no
        ProgressListener is wired up in production, so the bar sits at 35
        for the whole decode.  Downloading the models takes 50..58, the
        diarization pass itself 60..90.

        Both imports are deferred.  models/diarization_models.py pulls in
        urllib/tarfile, and diarization.py reaches for sherpa-onnx the
        moment a SherpaDiarizer is built -- neither belongs in the import
        graph of a run with diarization switched off.
        """
        from . import diarization
        from .models import diarization_models

        cfg = self._config
        models_dir = self._model_manager.models_dir
        megabytes = round(diarization_models.TOTAL_DOWNLOAD_BYTES / 1024 / 1024)

        segmentation_model, embedding_model = self._ensure_diarization_models(
            diarization, diarization_models, models_dir, megabytes
        )

        self._emitter.stage(
            STAGE_DIARIZING,
            message="Identifying speakers",
            message_key="events:stage.diarizing",
            progress=60,
        )

        def report(value: float) -> None:
            self._emitter.stage(
                STAGE_DIARIZING,
                message="Identifying speakers",
                message_key="events:stage.diarizing",
                progress=round(value),
            )

        diarizer = diarization.SherpaDiarizer(
            segmentation_model,
            embedding_model,
            num_speakers=cfg.diarize_num_speakers,
            threshold=cfg.diarize_threshold,
        )
        perf_start = time.perf_counter()
        turns = diarizer.diarize_file(
            str(input_path),
            on_progress=diarization.ProgressThrottle(report, start=60.0, span=30.0),
        )
        _log.info("diarization took %.2fs", time.perf_counter() - perf_start)

        template = diarization.resolve_label_template(cfg.speaker_label_template)
        segments = diarization.assign_speakers(result.get("segments") or [], turns)
        # One label per turn rather than one per segment; subtitle
        # segmentation thins its own labels by the same rule.
        diarization.label_speaker_turns(segments, template)
        result["segments"] = segments
        # The backend builds result["text"] once from the pre-split
        # segments and nothing recomputed it afterwards, so it has been
        # stale for every diarized run.  "".join is the one join correct
        # for both conventions: faster-whisper carries the separator
        # inside each Latin word and omits it for CJK.
        result["text"] = "".join(
            str(word.get("word", ""))
            for segment in segments
            for word in (segment.get("words") or [])
        ).strip() or result.get("text", "")

    def _ensure_diarization_models(
        self,
        diarization,
        diarization_models,
        models_dir: Path,
        megabytes: int,
    ) -> tuple[Path, Path]:
        """Download the two ONNX models if they aren't cached yet.

        Two message variants, mirroring _ensure_silero_vad: the cold path
        names the download size so the user understands the pause, the warm
        path uses shorter copy that doesn't imply a download is coming.
        """
        if diarization_models.is_diarization_cached(models_dir):
            self._emitter.stage(
                STAGE_DIARIZING,
                message="Preparing speaker diarization",
                message_key="events:stage.preparingDiarization",
                progress=58,
            )
            return diarization_models.ensure_diarization_models(models_dir)

        self._emitter.stage(
            STAGE_DIARIZING,
            message=(
                f"Downloading speaker diarization models "
                f"(~{megabytes} MB, first run only)"
            ),
            message_key="events:stage.downloadingDiarizationModels",
            message_params={"size": megabytes},
            progress=50,
        )

        # Map downloaded bytes onto 50..58 so a slow connection doesn't
        # look like a hang.
        download_progress = diarization.ProgressThrottle(
            lambda value: self._emitter.stage(
                STAGE_DIARIZING,
                message=(
                    f"Downloading speaker diarization models "
                    f"(~{megabytes} MB, first run only)"
                ),
                message_key="events:stage.downloadingDiarizationModels",
                message_params={"size": megabytes},
                progress=round(value),
            ),
            start=50.0,
            span=8.0,
        )

        def on_download(event_type: str, payload: dict) -> None:
            if event_type != "progress":
                return
            total = payload.get("total_bytes") or 0
            if total <= 0:
                return
            download_progress(min(1.0, (payload.get("downloaded_bytes") or 0) / total))

        return diarization_models.ensure_diarization_models(
            models_dir, progress=on_download
        )

    # --- subtitle segmentation -----------------------------------------

    def _run_segmentation(self, result: TranscribeResult) -> None:
        """Re-cut ``result["segments"]`` into subtitle-sized cues.

        Progress is a single tick at 91: diarization's band tops out at 90
        and subtitle writing is 92, so nothing existing has to move.  The
        pass is pure Python -- around two seconds for a continuous
        seven-thousand-word run, less when the speech breaks into shorter
        runs -- so it does not need a band of its own.

        The import is deferred only for symmetry with _run_diarization;
        the module is stdlib-only and costs nothing to import.
        """
        from .subtitles import segmentation

        cfg = self._config
        self._emitter.stage(
            STAGE_SEGMENTING,
            message="Splitting subtitles into short cues",
            message_key="events:stage.segmenting",
            progress=91,
        )

        label_for = None
        if cfg.diarize:
            from . import diarization

            template = diarization.resolve_label_template(cfg.speaker_label_template)

            def label_for(speaker):  # noqa: F811 - deliberate conditional def
                return diarization.speaker_label(speaker, template)

        options = segmentation.SegmentationOptions(
            max_line_chars=cfg.max_line_width,
            max_lines=cfg.subtitle_max_lines,
            max_duration=cfg.subtitle_max_duration,
            min_duration=cfg.subtitle_min_duration,
            run_gap=cfg.subtitle_run_gap,
        )
        perf_start = time.perf_counter()
        stats = segmentation.apply_to_result(
            result,
            options,
            # The user's explicit language wins over Whisper's detection.
            # cfg.language may be a NAME ("Chinese"); profile_for resolves
            # either through languages.resolve_language_code.
            language=cfg.language or result.get("language"),
            label_for=label_for,
        )
        _log.info("subtitle segmentation took %.2fs", time.perf_counter() - perf_start)
        _log.info("%s", stats.log_message())

    def _ensure_silero_vad(self) -> SileroVad:
        if isinstance(self._vad_model, SileroVad):
            return self._vad_model

        # Emit a stage event so the user knows why the UI briefly stalls.
        # Two variants:
        #   - Cold path (first run): ~10 MB download via torch.hub →
        #     surface the download size so the user doesn't panic.
        #   - Warm path (subsequent runs): load from managed cache → use
        #     a shorter phrasing that doesn't misleadingly imply a
        #     download is about to happen, and clarifies VAD is just a
        #     pre-processing step (users have confused this with Whisper
        #     itself).
        cached = is_silero_vad_cached(self._model_manager.torch_hub_dir)
        if cached:
            self._emitter.stage(
                STAGE_LOADING_VAD,
                message="Preparing voice activity detection (Silero VAD)",
                message_key="events:stage.preparingVad",
                progress=25,
            )
        else:
            self._emitter.stage(
                STAGE_LOADING_VAD,
                message="Downloading Silero VAD speech detection model (~10 MB, first run only)",
                message_key="events:stage.loadingVad",
                progress=25,
            )

        self._vad_model = SileroVad(
            cache=GLOBAL_MODEL_CACHE,
            torch_hub_dir=self._model_manager.torch_hub_dir,
        )
        return self._vad_model

    def _build_vad_config(self, non_speech_strategy: NonSpeechStrategy) -> TranscriptionConfig:
        cfg = self._config
        return TranscriptionConfig(
            non_speech_strategy=non_speech_strategy,
            max_silent_period=cfg.vad_merge_window,
            max_merge_size=cfg.vad_max_merge_size,
            segment_padding_left=cfg.vad_padding,
            segment_padding_right=cfg.vad_padding,
            max_prompt_window=cfg.vad_prompt_window,
        )

    def _run_vad(self, audio_path: str, callback) -> TranscribeResult:
        cfg = self._config

        if cfg.vad == "none":
            if self._has_parallel_devices():
                vad = PeriodicVad()
                periodic = PeriodicTranscriptionConfig(
                    periodic_duration=float("inf"),
                    max_prompt_window=1.0,
                )
                return self._dispatch_vad(vad, audio_path, callback, periodic)
            # Decode with our own ffmpeg-CLI loader rather than handing the
            # path to faster-whisper.  This was the one code path that still
            # relied on faster-whisper's PyAV-based decode_audio(), which
            # breaks on av 19 (see the av<19 pin in requirements.txt), and it
            # is also the only path that never raised InputFileVanishedError
            # for a file deleted mid-run.  load_audio() returns exactly the
            # 16 kHz mono float32 ndarray model.transcribe() accepts, and it
            # is already the decoder every other VAD mode depends on.
            samples = load_audio(audio_path, sample_rate=16000)
            return callback.invoke(samples, 0, None, None, progress_listener=self._listener)

        if cfg.vad == "periodic-vad":
            vad = PeriodicVad()
            periodic = PeriodicTranscriptionConfig(
                periodic_duration=cfg.vad_max_merge_size,
                max_prompt_window=cfg.vad_prompt_window,
            )
            return self._dispatch_vad(vad, audio_path, callback, periodic)

        # silero-vad variants ------------------------------------------------
        if cfg.vad == "silero-vad":
            strategy = NonSpeechStrategy.CREATE_SEGMENT
        elif cfg.vad == "silero-vad-skip-gaps":
            strategy = NonSpeechStrategy.SKIP
        elif cfg.vad == "silero-vad-expand-into-gaps":
            strategy = NonSpeechStrategy.EXPAND_SEGMENT
        else:
            raise ValueError(f"unknown VAD mode: {cfg.vad}")

        vad = self._ensure_silero_vad()
        # Reclaim the stage message before the long Whisper transcription
        # loop starts — otherwise the "preparing VAD" line emitted by
        # `_ensure_silero_vad` sticks for the entire run and users think
        # only VAD is working (faster-whisper core gets no on-screen
        # credit during its actual transcription phase).
        self._emitter.stage(
            STAGE_TRANSCRIBING,
            message=f"Whisper transcribing · model {cfg.model}",
            message_key="events:stage.transcribingWhisper",
            message_params={"model": cfg.model},
            progress=35,
        )
        vad_config = self._build_vad_config(strategy)
        return self._dispatch_vad(vad, audio_path, callback, vad_config)

    def _dispatch_vad(
        self,
        vad: AbstractVadTranscription,
        audio_path: str,
        callback,
        vad_config: TranscriptionConfig,
    ) -> TranscribeResult:
        if not self._has_parallel_devices():
            return vad.transcribe(audio_path, callback, vad_config, progress_listener=self._listener)

        cfg = self._config
        gpu_devices = list(cfg.gpu_devices) if cfg.gpu_devices else [os.environ.get("CUDA_VISIBLE_DEVICES")]

        if self._gpu_context is None:
            self._gpu_context = ParallelContext(num_processes=len(gpu_devices), idle_timeout_seconds=3600)
        if self._cpu_context is None and cfg.cpu_parallelism > 1:
            self._cpu_context = ParallelContext(num_processes=cfg.cpu_parallelism, idle_timeout_seconds=3600)

        parallel = ParallelVadTranscription()
        return parallel.transcribe_parallel(
            vad=vad,
            audio_path=audio_path,
            callback=callback,
            config=vad_config,
            gpu_devices=[d for d in gpu_devices if d is not None] or gpu_devices,
            cpu_parallelism=cfg.cpu_parallelism,
            cpu_context=self._cpu_context,
            gpu_context=self._gpu_context,
            progress_listener=self._listener,
        )

    def _has_parallel_devices(self) -> bool:
        cfg = self._config
        return len(cfg.gpu_devices) > 0 or cfg.cpu_parallelism > 1

    # --- output writing ------------------------------------------------

    def _write_outputs(self, result: TranscribeResult, source: Path) -> TranscribeOutputs:
        cfg = self._config
        output_dir = Path(cfg.output_dir) if cfg.output_dir else source.parent
        output_dir.mkdir(parents=True, exist_ok=True)

        base_name = cfg.output_name or source.stem

        def resolve(path: Path) -> Optional[Path]:
            """Apply overwrite_policy.  Returns the path to write to, or
            None when the caller should skip writing entirely."""
            if not path.exists():
                return path
            policy = (cfg.overwrite_policy or "overwrite").lower()
            if policy == "skip":
                return None
            if policy == "rename-suffix":
                stem = path.stem
                suffix = path.suffix
                parent = path.parent
                for i in range(1, 1000):
                    candidate = parent / f"{stem}.{i}{suffix}"
                    if not candidate.exists():
                        return candidate
                return path  # give up after 1000 — overwrite as last resort
            # "overwrite" or any unknown value
            return path

        srt_path = None
        vtt_path = None
        txt_path = None
        json_path = None

        # When segmentation ran it already broke every cue into at most
        # subtitle_max_lines lines of at most max_line_width characters,
        # and those breaks live in the cue's own text.  Handing
        # max_line_width to the writers as well would re-wrap text that
        # already contains "\n": _wrap_text counts a newline as one
        # printable character, so it mis-measures every line after the
        # first and can emit "\n\n" -- which terminates the SRT/VTT cue
        # block and makes transcript-reader.js's parseSrt silently drop
        # everything after it.
        wrap_width = None if cfg.subtitle_segmentation else cfg.max_line_width

        if cfg.write_srt:
            target = resolve(output_dir / f"{base_name}.srt")
            if target is not None:
                srt_path = target
                with target.open("w", encoding="utf-8") as f:
                    write_srt(result["segments"], f, max_line_width=wrap_width)
        if cfg.write_vtt:
            target = resolve(output_dir / f"{base_name}.vtt")
            if target is not None:
                vtt_path = target
                with target.open("w", encoding="utf-8") as f:
                    write_vtt(result["segments"], f, max_line_width=wrap_width)
        if cfg.write_txt:
            target = resolve(output_dir / f"{base_name}.txt")
            if target is not None:
                txt_path = target
                with target.open("w", encoding="utf-8") as f:
                    write_txt(result["segments"], f)
        if cfg.write_json:
            target = resolve(output_dir / f"{base_name}.json")
            if target is not None:
                json_path = target
                target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

        return TranscribeOutputs(
            srt_path=srt_path,
            vtt_path=vtt_path,
            txt_path=txt_path,
            json_path=json_path,
            result=result,
        )
