# WhisperFlow Studio

A desktop GUI for [faster-whisper-webui](https://github.com/jhj0517/faster-whisper-webui) — automatically scan a media directory for files without subtitles, then run AI speech-to-text transcription with a single click.

Built with Electron 35, vanilla JS renderer, pastel cream/yellow theme with dark mode support.

---

## What it does

| Step | Action |
|------|--------|
| 1 | Point the app at a folder containing video/audio files |
| 2 | **Scan for Missing Subtitles** — finds the first file that has no `.srt` / `.vtt` companion |
| 3 | **Run Transcription** — calls `faster-whisper-webui`'s CLI to generate subtitles |
| 4 | Repeat until all files are covered (or enable **Auto-loop** to do it automatically) |

The real-time console panel streams Python output (stdout + stderr) directly into the UI so you can monitor transcription progress without opening a terminal.

---

## Features

### Core
- **Media scan** — recursively finds the first media file without a subtitle companion
- **One-click transcription** — runs `faster-whisper-webui` via Poetry CLI
- **Real-time console** — streams Python stdout/stderr with timestamps and color-coded log levels
- **Settings panel** — edit all Whisper parameters (model, language, VAD, prompts, paths) in-app
- **Profile switcher** — switch between multiple config profiles (shown when more than one profile exists)
- **Drag & drop** — drag a folder onto the directory card to set the media root

### UX
- **Auto-loop mode** — Scan → Transcribe → Scan cycles automatically until all files are done
- **Next to Transcribe card** — shows the found file name, path, and **total pending count badge** after each scan
- **Transcription history** — last 10 transcribed files (✓ success / ✗ fail) displayed in the main panel; persisted across sessions
- **Recent directories** — last 5 used directories shown below the directory card for one-click re-selection
- **Reveal in Finder** — open the scanned file's parent folder directly from the UI
- **Window memory** — window size and position are restored on next launch
- **Step guide** — onboarding hints shown when no directory is selected
- **Dirty state indicator** — Save button highlights when settings have unsaved changes
- **Settings section collapse** — each settings group is collapsible; state persisted across sessions
- **Toast notifications** — success / info / error feedback for every action
- **Execution timer** — status bar shows elapsed time (`Running 01:23`) while a process is running
- **Window title status** — title bar shows `● Running` during transcription

### Console tools
- **Log level filters** — filter console output by All / Error / Warn / OK
- **Console search** — Cmd+F to find text in the log; shows match count
- **Copy** — copy full log to clipboard
- **Save Log** — export log to a `.txt` file via save dialog
- **Clear** — manually clear the console (never clears automatically)
- **Auto-scroll lock** — toggle to freeze scroll position

### Appearance
- **Light / dark theme toggle** — pastel cream yellow (light) and warm dark (dark); persisted via localStorage
- **System theme detection** — defaults to OS preference on first launch

### Keyboard shortcuts
| Shortcut | Action |
|----------|--------|
| `Cmd+S` | Save settings (when Settings tab is active) |
| `Cmd+K` | Clear console |
| `Cmd+F` | Open console search |
| `Escape` | Close console search |
| `?` | Show keyboard shortcuts panel |

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js** ≥ 18 | For running the Electron app |
| **Poetry** | Python dependency manager; must be findable in PATH or a known location |
| **[faster-whisper-webui](https://github.com/jhj0517/faster-whisper-webui)** | The Python backend that does the actual transcription |
| **WhisperFlow Studio `python/` helpers** | Included in this repo; they handle scan logic and the headless CLI bridge |

---

## Setup

### 1. Install Node dependencies

```bash
npm install
```

### 2. Configure local app settings

Copy the settings template and edit it:

```bash
cp settings.example.json settings.json
```

Open `settings.json` and, if needed, set a custom `poetryPath`:

```json
{
  "poetryPath": null
}
```

`poetryPath` can be left `null` — the app searches common install locations automatically (`~/.local/bin/poetry`, `/opt/homebrew/bin/poetry`, etc.). Set it only if Poetry is installed somewhere non-standard.

### 3. Configure transcription settings

WhisperFlow Studio now uses `python/config/config.json` as the single source of truth for transcription settings.

If `python/config/config.json` does not exist yet in your local checkout, create it from the template first:

```bash
cp python/config/config.example.json python/config/config.json
```

On first run:

1. Open the **Settings** tab
2. Set `whisper_faster_tool_path` to your `faster-whisper-webui` directory
3. Optionally adjust model, language, VAD, and prompt defaults
4. Click **Save**

### 4. Run

```bash
npm run dev
# or
npm start
```

---

## Project structure

```
whisperflow-studio/
├── bridge/
│   └── run_cli.py               # Python bridge: headless CLI runner (streams output to Electron)
├── python/
│   ├── config/
│   │   ├── config.example.json  # Tracked template for local runtime config
│   │   ├── config.metadata.json # Shared UI/options/media-extension metadata
│   │   └── config.json          # Main transcription config (single source of truth)
│   ├── config_metadata.py       # Python helper for reading shared config metadata
│   ├── config_setting.py        # Scan media root, update next pending file in config.json
│   ├── faster-whisper-webui-cli.run.py # Shared CLI wrapper logic
│   └── subtitle_utils.py        # Subtitle detection helpers
├── preload/
│   └── preload.js               # Electron contextBridge (exposes window.electronAPI)
├── src/
│   ├── main/
│   │   ├── main.js              # App bootstrap, window creation, dock icon
│   │   ├── ipc-handlers.js      # All IPC channels (config, fs dialogs, process runners)
│   │   ├── config-metadata.js   # Reads shared config metadata for Electron
│   │   ├── python-runner.js     # Spawns Poetry subprocesses, streams stdout/stderr
│   │   ├── config-manager.js    # Reads/writes and normalizes config.json
│   │   └── path-resolver.js     # Locates the Poetry executable
│   └── renderer/
│       ├── index.html           # Main HTML template
│       ├── index.js             # Tab switching, directory drag-drop, theme, keyboard shortcuts
│       ├── styles.css           # Pastel cream/yellow theme (light + dark)
│       └── components/
│           ├── controls-bar.js      # Scan / Run Transcription / Stop / auto-loop logic
│           ├── settings-panel.js    # Whisper settings form, dirty tracking, section collapse
│           ├── console-log.js       # Real-time log panel, filters, search, save log
│           ├── profile-switcher.js  # Profile switching UI
│           └── toast.js             # Toast notification system
├── assets/                      # App icons
├── scripts/
│   └── patch-icon.js            # Postinstall: patches electron.icns for dev mode dock icon
├── settings.json                # Local portable settings (gitignored)
├── settings.example.json        # Template — copy to settings.json and edit
└── package.json
```

---

## Settings

### `settings.json` (portable, gitignored)

Stored in the project root during development. In packaged builds it lives in Electron `userData`.

| Key | Type | Description |
|-----|------|-------------|
| `poetryPath` | `string \| null` | Absolute path to the `poetry` binary; `null` = auto-detect |

### `python/config/config.json`

Whisper transcription settings. Edited via the **Settings** tab inside the app.
This file is the only runtime config for scan/transcription state.
`python/config/config.example.json` is the tracked template; `config.json` is the local working copy.

| Key | Description |
|-----|-------------|
| `whisper_implementation` | Backend mode passed to `faster-whisper-webui` |
| `python_executor` | Stored for compatibility with the Python wrapper; default is `poetry` |
| `model` | Whisper model size (`large-v2`, `medium`, …) |
| `fp16_enabled` / `auto_parallel_enabled` | Execution flags forwarded to the CLI |
| `language` | Target language for transcription |
| `initial_prompt` | Hint text fed to Whisper (e.g. `台灣繁體中文` for Traditional Chinese output) |
| `vad_argument` | Voice activity detection strategy |
| `vad_max_merge_size` | Merge nearby VAD segments within the given number of seconds |
| `vad_initial_prompt_mode` | How the initial prompt is applied during VAD runs |
| `whisper_faster_tool_path` | Path to the `faster-whisper-webui` installation |
| `media_root_path` | Directory to scan for media files |
| `media_file_name` / `media_file_path` | Set automatically after a scan |
| `missing_count` | Number of remaining media files without subtitles after the last scan |

> Selecting a language in the Settings tab auto-fills `initial_prompt` with a sensible preset for that language.

### `WEBUI_SETTING` in `python/config/config.json`

Legacy WebUI-related defaults are also preserved in JSON form, including:

- `server_name`
- `server_port`
- `default_model_name`
- `input_audio_max_duration`
- `default_vad`

If a legacy `python/config/config.ini` still exists, WhisperFlow Studio will import missing or still-default values from it into `config.json` automatically.

### `python/config/config.metadata.json`

Tracked metadata for non-user-editable app constants shared across Electron and Python:

- settings form enum options
- language-to-prompt presets
- media file extensions for browse/scan
- subtitle file extensions for detection
- app runtime defaults such as window sizing and Poetry path discovery

---

## Usage

### Selecting a media directory

- **Browse** — click the Browse button to open a folder picker
- **Drag and drop** — drag a folder (or any file inside it) onto the directory card

### Scan → Transcribe workflow

1. Set the media directory
2. Click **Scan for Missing Subtitles** — the console shows scan results; the "Next to Transcribe" card updates with the found file
3. Click **Run Transcription** — transcription streams in the console in real time
4. Click **Scan** again to find the next file; repeat until done

Or enable **自動循環模式** (Auto-loop) to have the app cycle through all files automatically.

### Settings tab

- Adjust model, language, VAD, initial prompt, and other Whisper parameters
- Click **Save** to write changes to `python/config/config.json`
- Switching the **language** dropdown auto-fills `initial_prompt` with a language-appropriate preset
- Each settings section can be collapsed; the state is remembered across sessions

---

## Moving the app

Because runtime settings live in `settings.json` and `python/config/config.json`, you can move the project directory anywhere as long as your external tool paths still point to valid locations:

1. Move the folder to the new location
2. Run `npm install` (restores `node_modules`)
3. Check `settings.json` if you use a custom `poetryPath`
4. Open the app and update `whisper_faster_tool_path` in the **Settings** tab if the `faster-whisper-webui` path changed
5. `npm run dev`

---

## Building a distributable

```bash
npm run build:mac    # macOS .dmg
npm run build:win    # Windows installer
npm run build:linux  # Linux AppImage
```

Output goes to `dist/`.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Electron 35 |
| Renderer | Vanilla JS (ES modules), no framework |
| Styling | CSS custom properties, pastel cream/yellow palette (light + dark) |
| Config I/O | JSON files via `fs` (`python/config/config.json`, `settings.json`) |
| Python subprocess | `child_process.spawn` with `PYTHONUNBUFFERED=1` |
| ANSI stripping | `strip-ansi@6.0.1` (pinned CJS build) |
| Packaging | electron-builder |
