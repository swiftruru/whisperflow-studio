<!-- markdownlint-disable MD033 MD041 -->
<!--
  Inline HTML is intentional in this file: GitHub-flavored markdown has no
  alignment primitives, so the centered header, badge rows, and download
  buttons below all rely on <p align="center"> and <img>.  The lint
  directive above silences MD033 (no-inline-html) for this README only.
-->

<h1 align="center">🎙️ WhisperFlow Studio</h1>

<p align="center">
  <strong>Self-contained desktop transcription for macOS, Windows &amp; Linux</strong><br>
  Point at a folder, scan for files without subtitles, click Run. No external Python project, no Poetry, no path setup.
</p>

<p align="center">
  <a href="https://github.com/swiftruru/whisperflow-studio/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/swiftruru/whisperflow-studio/release.yml?label=build&logo=github&style=flat-square" alt="Build"></a>
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest"><img src="https://img.shields.io/github/v/release/swiftruru/whisperflow-studio?label=release&color=orange&style=flat-square" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="Platforms">
  <img src="https://img.shields.io/badge/i18n-zh--TW%20%7C%20en-ff69b4?style=flat-square" alt="i18n">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-35-47848F?logo=electron&logoColor=white&style=flat-square" alt="Electron 35">
  <img src="https://img.shields.io/badge/Vanilla%20JS-ESM-F7DF1E?logo=javascript&logoColor=black&style=flat-square" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white&style=flat-square" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/faster--whisper-0.10+-4B8BBE?style=flat-square" alt="faster-whisper">
  <img src="https://img.shields.io/badge/CTranslate2-3.24+-ff9800?style=flat-square" alt="CTranslate2">
  <img src="https://img.shields.io/badge/PyTorch-2.1+-EE4C2C?logo=pytorch&logoColor=white&style=flat-square" alt="PyTorch">
  <img src="https://img.shields.io/badge/Silero%20VAD-latest-6DB33F?style=flat-square" alt="Silero VAD">
</p>

---

## 📦 Download

Pre-built binaries are published on every tagged release. Pick your platform:

<p align="center">
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest/download/WhisperFlow-Studio-arm64.dmg">
    <img src="https://img.shields.io/badge/download-macOS%20Apple%20Silicon-000000?logo=apple&logoColor=white&style=for-the-badge" alt="macOS Apple Silicon">
  </a>
  &nbsp;
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest/download/WhisperFlow-Studio-x64.dmg">
    <img src="https://img.shields.io/badge/download-macOS%20Intel-8a8a8a?logo=apple&logoColor=white&style=for-the-badge" alt="macOS Intel">
  </a>
  &nbsp;
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest/download/WhisperFlow-Studio-Setup.exe">
    <img src="https://img.shields.io/badge/download-Windows%20Installer-0078D6?logo=windows&logoColor=white&style=for-the-badge" alt="Windows Installer">
  </a>
  &nbsp;
  <a href="https://github.com/swiftruru/whisperflow-studio/releases/latest/download/WhisperFlow-Studio.AppImage">
    <img src="https://img.shields.io/badge/download-Linux%20AppImage-FCC624?logo=linux&logoColor=black&style=for-the-badge" alt="Linux AppImage">
  </a>
</p>

<p align="center">
  <sub>
    🔒 Built on GitHub Actions from the tagged commit. Checksums match the files uploaded by the workflow.<br>
    🐍 First launch will automatically create a local Python virtualenv under your app data directory and install <code>faster-whisper</code>, <code>torch</code> and friends — expect a one-time 5–10 min setup.
  </sub>
</p>

---

## Overview

A self-contained desktop app for fast, accurate speech-to-text transcription. Point it at a folder, scan for files without subtitles, and let it generate `.srt` / `.vtt` / `.txt` / `.json` for every missing item — all powered by [faster-whisper](https://github.com/SYSTRAN/faster-whisper) running inside the app's own bundled Python environment. No external tools to install, no paths to configure, no extra project to clone.

Built with Electron 35, a vanilla-JS renderer, and a from-scratch Python transcription core that lives in [`python/whisperflow/`](python/whisperflow/).

---

## What it does

| Step | Action |
|------|--------|
| 1 | Point the app at a folder containing video/audio files |
| 2 | **Scan for Missing Subtitles** — builds a queue of media files without `.srt` / `.vtt` companions |
| 3 | **Run Transcription** — pipes the current queued file through the bundled `whisperflow` Python package |
| 4 | Monitor the batch queue, then **Pause / Resume / Skip Current / Stop Batch** as needed |
| 5 | Enable **Auto-loop** to keep processing queued items until the batch is done |

The real-time console panel streams Python output (stdout + stderr) directly into the UI so you can monitor transcription progress without opening a terminal.

---

## Features

### Core

- **Self-contained transcription core** — [`python/whisperflow/`](python/whisperflow/) is a rewritten, dependency-isolated Python package that drives faster-whisper, Silero VAD, segment merging, and subtitle writers. No external project required.
- **Batch media scan** — recursively builds a queue of media files without subtitle companions
- **Model Manager tab** — list / download / delete faster-whisper models into an app-managed directory; all weights live under Electron's `userData/models/`, not in your global HuggingFace cache
- **First-run venv bootstrap** — the app creates its own Python virtualenv (`python/.venv`) on first launch and installs `requirements.txt` for you
- **Structured runner events** — the bridge emits machine-readable stage events (`preparing`, `loading-model`, `transcribing`, `writing-subtitle`, `completed`, `failed`) that drive the progress UI
- **Multi-GPU parallel transcription** — preserved from the upstream architecture, fans work across CUDA devices on Linux/Windows
- **Preflight checks** — validates the bundled Python environment, `whisperflow` package, and media root before running
- **Settings panel** — edit model, language, VAD, initial prompt, device, and compute type in-app

### UX

- **Auto-loop mode** — one scan builds the batch queue, then queued items run continuously until done
- **System Check panel** — surfaces blocking setup problems and links directly to the right settings field
- **Next to Transcribe card** — current queued file name, path, and remaining count
- **Batch Progress card** — queue stage, processed counts, per-batch scan summary, elapsed / ETA timing
- **Queue panel** — lists pending / running / paused / done / skipped / failed items, with search and status chips
- **Single-item queue controls** — retry, remove, move items up/down directly from the queue list
- **Queue persistence** — queue state is restored after app restart so pending/skipped/failed work is not lost
- **Pause / Resume / Skip Current / Stop Batch** — control the current queued transcription without losing the rest of the queue
- **Transcription history** — last 10 transcribed files (✓ / ✗) persisted across sessions
- **Recent directories** — last 5 used directories shown below the directory card for one-click re-selection
- **Toast notifications** — success / info / error feedback for every action
- **Structured error UI** — runtime failures are normalized into actionable banners/dialogs instead of raw stderr

### Console tools

- **Log level filters** — All / Error / Warn / OK
- **Console search** — Cmd+F to find text in the log; shows match count
- **Copy / Save Log / Clear / Auto-scroll lock**

### Appearance

- **Light / dark theme toggle** — pastel cream yellow (light) and warm dark (dark); persisted
- **System theme detection** — defaults to OS preference on first launch

### Keyboard shortcuts
| Shortcut | Action |
|----------|--------|
| `Cmd+S` | Save settings (Settings tab active) |
| `Cmd+K` | Clear console |
| `Cmd+F` | Open console search |
| `Escape` | Close console search |
| `?` | Show keyboard shortcuts panel |

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js** ≥ 18 | For running the Electron app |
| **Python** ≥ 3.10 | Used only to bootstrap the app's own virtualenv on first launch. Must be on PATH or specified via `pythonPath` in `settings.json`. |
| **ffmpeg** | Required at runtime for audio decoding. Install via `brew install ffmpeg` (macOS), `apt install ffmpeg` (Linux), or [ffmpeg.org](https://ffmpeg.org/) (Windows). |

> **No external faster-whisper-webui needed.** Previous versions required a separate Python project and a Poetry install. v1.4.0 rewrote the transcription core directly into `python/whisperflow/` and uses an in-app venv, so you only need Python 3.10+ on PATH.

---

## Setup

### 1. Install Node dependencies

```bash
npm install
```

### 2. Configure local app settings (optional)

```bash
cp settings.example.json settings.json
```

`settings.json` holds portable overrides. The only key you might need is `pythonPath`:

```json
{
  "pythonPath": null
}
```

- `null` (default) → auto-detect system Python 3 from PATH and common install locations
- Set a string path only if your Python 3.10+ is installed somewhere non-standard

### 3. Run

```bash
npm run dev
# or
npm start
```

### 4. First-run bootstrap

On first launch the **System Check** panel will show a warning:

> **Python 虛擬環境尚未建立** · 第一次執行轉錄時會自動建立 `python/.venv/` 並安裝依賴（約數百 MB）。

Click **立即建立環境** to run:

1. `python3 -m venv python/.venv`
2. `pip install --upgrade pip`
3. `pip install -r python/requirements.txt`

This downloads `faster-whisper`, `ctranslate2`, `torch`, `torchaudio`, and a few smaller dependencies. Expect 2-10 minutes depending on network speed.

Progress streams live to the Console panel.

### 5. Download a model

Open the **Models** tab and click **下載** next to the model you want (e.g. `large-v2`). Models go to:

- **macOS**: `~/Library/Application Support/WhisperFlow Studio/models/`
- **Windows**: `%APPDATA%/WhisperFlow Studio/models/`
- **Linux**: `~/.config/WhisperFlow Studio/models/`

The Silero VAD weights share the same directory (under `torch_hub/`) so your global `~/.cache/` stays clean.

---

## Project structure

```
whisperflow-studio/
├── bridge/
│   └── run_cli.py                 # Thin Electron → whisperflow adapter (~90 lines)
├── python/
│   ├── pyproject.toml             # Bundled Python project metadata
│   ├── requirements.txt           # venv dependency list
│   ├── config/
│   │   ├── config.example.json    # Tracked template for local runtime config
│   │   ├── config.metadata.json   # UI enum options, bundled-python metadata
│   │   └── config.json            # Main transcription config (single source of truth)
│   ├── config_setting.py          # Media scan helper invoked from Electron
│   ├── config_metadata.py         # Python helper for reading shared metadata
│   ├── subtitle_utils.py          # Subtitle-detection helpers for the scan
│   └── whisperflow/               # Transcription core
│       ├── cli.py                 # argparse entry point + --list-models / --download-model / --delete-model
│       ├── transcriber.py         # Orchestrator: model load → VAD → whisper → write outputs
│       ├── config.py              # TranscribeConfig dataclass
│       ├── events.py              # [WhisperFlowEvent] JSON emitter
│       ├── languages.py           # Full Whisper-99 language table
│       ├── progress.py            # ProgressListener protocol + SubTaskProgressListener
│       ├── audio/source.py        # Local-file AudioSource wrapper
│       ├── subtitles/writers.py   # SRT / VTT / TXT writers
│       ├── models/
│       │   ├── registry.py        # Built-in faster-whisper model catalogue
│       │   ├── manager.py         # Cross-platform models dir + download/list/delete
│       │   ├── cache.py           # Thread-safe model cache
│       │   ├── whisper_container.py
│       │   └── faster_whisper_backend.py
│       ├── vad/
│       │   ├── base.py            # AbstractVadTranscription + merge/gap helpers
│       │   ├── silero.py          # Silero VAD (torch.hub pinned to managed dir)
│       │   ├── periodic.py        # Fixed-interval fallback VAD
│       │   ├── parallel.py        # Multi-GPU parallel driver (CUDA)
│       │   └── segments.py        # merge_timestamps()
│       ├── prompts/
│       │   ├── base.py            # PromptStrategy protocol + InitialPromptMode enum
│       │   ├── prepend.py         # Prepend-all / prepend-first
│       │   └── json_prompt.py     # Per-segment JSON-driven prompts
│       └── tests/                 # pytest unit tests (46 tests, lightweight)
├── preload/
│   └── preload.js                 # Electron contextBridge (window.electronAPI)
├── src/
│   ├── main/
│   │   ├── main.js                # App bootstrap, window creation
│   │   ├── ipc-handlers.js        # All IPC channels (config, fs, runners, models, venv)
│   │   ├── config-metadata.js     # Reads shared config metadata
│   │   ├── preflight-checker.js   # Environment checks (venv, whisperflow package, media root)
│   │   ├── venv-installer.js      # First-run venv creation + pip install
│   │   ├── queue-manager.js       # Batch queue state and job lifecycle
│   │   ├── queue-storage.js       # Persists queue state to userData
│   │   ├── runner-event.js        # [WhisperFlowEvent] parser
│   │   ├── runner-metrics.js      # Elapsed / ETA helpers
│   │   ├── python-runner.js       # Spawns bundled venv python, streams stdio
│   │   ├── config-manager.js      # Reads/writes config.json
│   │   └── path-resolver.js       # Locates venv python + system python
│   └── renderer/
│       ├── index.html
│       ├── index.js
│       ├── styles.css
│       └── components/
│           ├── controls-bar.js
│           ├── preflight-panel.js
│           ├── queue-panel.js
│           ├── settings-panel.js   # Whisper settings form, dynamic model dropdown
│           ├── model-manager.js    # Models tab: list / download / delete
│           ├── console-log.js
│           ├── profile-switcher.js
│           ├── error-banner.js
│           ├── error-dialog.js
│           ├── error-actions.js
│           ├── error-state.js
│           ├── history.js
│           ├── queue-state.js
│           ├── queue-view-state.js
│           └── toast.js
├── NOTICES.md                     # Third-party attributions (Apache 2.0 for upstream)
├── settings.json                  # Local portable settings (gitignored)
├── settings.example.json          # Template
└── package.json
```

---

## Settings

### `settings.json` (portable, gitignored)

Stored in the project root during development; in packaged builds it lives in Electron `userData`.

| Key | Type | Description |
| --- | --- | --- |
| `pythonPath` | string or null | Absolute path to a system Python 3.10+ interpreter for venv bootstrap; `null` = auto-detect |

### `python/config/config.json`

Whisper transcription settings. Edited via the **Settings** tab inside the app. `python/config/config.example.json` is the tracked template; `config.json` is your local working copy.

| Key | Description |
|-----|-------------|
| `model` | Whisper model name (`tiny`, `base`, `small`, `medium`, `large-v1`, `large-v2`, `large-v3`). Only downloaded models appear in the Settings dropdown. |
| `models_dir` | Managed models directory; populated automatically from Electron's `userData/models/`. |
| `device` | `auto`, `cpu`, or `cuda`. |
| `compute_type` | `auto`, `float16`, `float32`, `int8`, `int8_float16`, `int8_float32`. |
| `vad` | Voice activity detection strategy: `none`, `silero-vad`, `silero-vad-skip-gaps`, `silero-vad-expand-into-gaps`, `periodic-vad`. |
| `vad_merge_window` | Silence window (seconds) within which consecutive speech segments are merged. |
| `vad_max_merge_size` | Maximum merged-segment length (seconds). |
| `vad_padding` | Padding added around each detected speech segment (seconds). |
| `vad_prompt_window` | Rolling prompt window length (seconds). |
| `language` | Target language (human-readable name; auto-detected if empty). |
| `initial_prompt` | Hint text fed to Whisper (e.g. `台灣繁體中文` for Traditional Chinese output). |
| `initial_prompt_mode` | `prepend_all_segments`, `prepend_first_segment`, or `json_prompt_mode`. |
| `media_root_path` | Directory to scan for media files. |
| `media_file_name` / `media_file_path` | Kept in sync with the current queue item for bridge compatibility. |
| `missing_count` | Remaining queue size after the last scan. |

> Queue state itself lives in Electron's main process (`queue-manager.js`), not inside `config.json`. Persisted queue snapshots live separately in Electron `userData/queue-state.json`.
>
> Selecting a language in the Settings tab auto-fills `initial_prompt` with a sensible preset.

### `python/config/config.metadata.json`

Tracked metadata for non-user-editable app constants shared across Electron and Python:

- settings form enum options (with a dynamic `model` dropdown fed by the Model Manager)
- language-to-prompt presets
- media file extensions for browse/scan
- subtitle file extensions for detection
- bundled-Python metadata (venv dir name, requirements file, minimum Python version)
- known system Python paths for venv bootstrap

---

## Usage

### Selecting a media directory

- **Browse** — click the Browse button to open a folder picker
- **Drag and drop** — drag a folder (or any file inside it) onto the directory card

### Model management

1. Open the **Models** tab
2. Review the built-in model catalogue (size, repo id, description)
3. Click **下載** next to a model to download it into the managed directory
4. Installed models appear with a green badge; click **刪除** to remove them

Models that aren't yet downloaded won't appear in the Settings tab's `model` dropdown — download first, then pick.

### Scan → Transcribe workflow

1. Set the media directory
2. Click **Scan for Missing Subtitles**
3. Click **Run Transcription**
4. While a job is running you can **Pause / Resume / Skip Current / Stop Batch**
5. Watch **Batch Progress** for current stage, elapsed time, ETA, and stage messages forwarded from Python

### System Check / Preflight

Preflight validates:

- `config.json` is readable
- The bundled `whisperflow` Python package exists
- The bundled venv is initialised (otherwise shows a warning with a **立即建立環境** button)
- Media root exists
- Bridge scripts exist

Errors block transcription; warnings (like "venv not initialised") do not — the user can dismiss them by clicking the inline action.

### Restart recovery

- Queue state is persisted in Electron `userData/queue-state.json`
- `running` jobs are restored as `failed` with an interruption message after app restart
- `paused` jobs are restored as `pending`

### Progress model

- `python/whisperflow/events.py` emits `[WhisperFlowEvent]` JSON lines to stdout
- Electron main (`runner-event.js`) parses them and updates queue state with `stage`, `progress`, `stageMessage`, `elapsedSeconds`, `etaSeconds`
- The renderer uses that queue state to drive the visible progress UI

---

## Moving the app

Because runtime settings live in `settings.json` and `python/config/config.json`, and the bundled venv lives inside the project directory, you can move the project directory anywhere:

1. Move the folder to the new location
2. Run `npm install` to restore `node_modules`
3. If `python/.venv/` was moved along with the project, it may contain absolute paths from its original location — delete it and re-run the bootstrap from the System Check panel
4. `npm run dev`

---

## Building a distributable

```bash
npm run build:mac    # macOS .dmg
npm run build:win    # Windows installer
npm run build:linux  # Linux AppImage
```

Output goes to `dist/`.

> The release build does **not** bundle a pre-built venv. The installed app ships with `python/whisperflow/` and `python/requirements.txt`, and the user's first launch creates a machine-local venv on demand. This keeps the installer under ~200 MB instead of ~2 GB, and avoids the venv-relocation problem across machines.

---

## Development

Run the Python unit tests (46 tests, lightweight — no torch required):

```bash
cd python
python3 -m venv .venv-test
.venv-test/bin/pip install pytest ffmpeg-python numpy
.venv-test/bin/python -m pytest whisperflow/tests/ -q
```

The same suite runs on every release in CI — see [`.github/workflows/release.yml`](.github/workflows/release.yml).

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Electron 35 |
| Renderer | Vanilla JS (ES modules), no framework |
| Styling | CSS custom properties, pastel cream/yellow palette (light + dark) |
| Transcription core | `whisperflow` package → faster-whisper + CTranslate2 + Silero VAD |
| Python env | Local `python/.venv/` created on first launch (no poetry, no external project) |
| Config I/O | JSON files via `fs` (`python/config/config.json`, `settings.json`) |
| Python subprocess | `child_process.spawn` with `PYTHONUNBUFFERED=1` |
| ANSI stripping | `strip-ansi@6.0.1` (pinned CJS build) |
| Packaging | electron-builder |

---

## Credits

WhisperFlow Studio's transcription core was originally derived (rewritten, not copied) from [aadnk/faster-whisper-webui](https://gitlab.com/aadnk/faster-whisper-webui), which is licensed under the Apache License 2.0. The Gradio WebUI layer, YouTube downloader, speaker diarization, and HuggingFace converter have been removed; the VAD/merge/prompt-strategy/transcription logic was rewritten into the `whisperflow` package with a cleaner type-hinted API. See [NOTICES.md](NOTICES.md) for full attribution.

Runtime transcription is powered by [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT) and [CTranslate2](https://github.com/OpenNMT/CTranslate2) (MIT), using [OpenAI Whisper](https://github.com/openai/whisper) model weights (MIT). Voice activity detection uses [Silero VAD](https://github.com/snakers4/silero-vad) (MIT).
