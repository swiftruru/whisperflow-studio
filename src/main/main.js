'use strict';

const { app, BrowserWindow, nativeImage, dialog } = require('electron');

app.name = 'WhisperFlow Studio';
const path = require('path');
const fs = require('fs');
const { getAppRuntimeConfig } = require('./config-metadata');
const { registerHandlers } = require('./ipc-handlers');

// ── Path Resolution ───────────────────────────────────────────────────────────
// In development:  ELECTRON_APP_ROOT = <project>/
// In packaged app: ELECTRON_APP_ROOT = <app>.app/Contents/Resources/
//   (python/ and bridge/ are placed there via extraResources in electron-builder.yml)
const APP_SOURCE_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON_APP_ROOT = app.isPackaged
  ? process.resourcesPath
  : APP_SOURCE_ROOT;
const CONFIG_METADATA_PATH = path.join(ELECTRON_APP_ROOT, 'python', 'config', 'config.metadata.json');
const APP_RUNTIME_CONFIG = getAppRuntimeConfig(CONFIG_METADATA_PATH);

// ── Augment PATH for packaged app ─────────────────────────────────────────────
// GUI apps launched from Finder / Explorer / a desktop launcher inherit a
// minimal PATH (usually only the system defaults).  They do NOT see the
// user's shell PATH, so tools the user installed via Homebrew, Scoop,
// apt --user, etc. are invisible.  We prepend the platform-appropriate
// install locations from config.metadata.json :: appRuntime.extraPathPrefixes
// so ffmpeg / ffprobe / and any other binary the Python side spawns can
// be found.
//
// Without this fix, hitting Run Transcription on a freshly-installed app
// fails inside Python with "[Errno 2] No such file or directory: 'ffprobe'"
// even though ``which ffprobe`` works fine in the user's terminal.
{
  const extraByPlatform = APP_RUNTIME_CONFIG.extraPathPrefixes || {};
  const extra = (extraByPlatform[process.platform] || []).map((p) =>
    typeof p === 'string' ? p.replace(/\$\{HOME\}/g, require('os').homedir()) : p
  );
  if (extra.length > 0) {
    const current = (process.env.PATH || '').split(path.delimiter);
    const merged = [...new Set([...extra, ...current])].join(path.delimiter);
    process.env.PATH = merged;
  }
}

// settings.json: portable in dev (lives with the project), userData in packaged build.
const SETTINGS_TEMPLATE_PATH = path.join(APP_SOURCE_ROOT, 'settings.example.json');
const LOCAL_SETTINGS_PATH = app.isPackaged
  ? path.join(app.getPath('userData'), 'settings.json')
  : path.join(APP_SOURCE_ROOT, 'settings.json');

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return fallback;
  }
}

function getDefaultLocalSettings() {
  return readJsonFile(SETTINGS_TEMPLATE_PATH, {});
}

function normalizeLocalSettings(data) {
  return {
    ...cloneJson(getDefaultLocalSettings()),
    ...(data || {}),
  };
}

function readLocalSettings() {
  const defaults = normalizeLocalSettings();
  const settings = readJsonFile(LOCAL_SETTINGS_PATH, defaults);
  const normalized = normalizeLocalSettings(settings);

  if (!fs.existsSync(LOCAL_SETTINGS_PATH)) {
    writeLocalSettings(normalized);
  }

  return normalized;
}

function writeLocalSettings(data) {
  fs.writeFileSync(LOCAL_SETTINGS_PATH, JSON.stringify(normalizeLocalSettings(data), null, 2), 'utf-8');
}

// ── Window State ──────────────────────────────────────────────────────────────
const WINDOW_STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
const WINDOW_DEFAULTS = APP_RUNTIME_CONFIG.windowDefaults || {};

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, 'utf-8'));
  } catch (_) {
    return {
      width: WINDOW_DEFAULTS.width,
      height: WINDOW_DEFAULTS.height,
    };
  }
}

function saveWindowState(win) {
  if (win.isMaximized() || win.isMinimized()) return;
  const bounds = win.getBounds();
  fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify(bounds), 'utf-8');
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;
let isRunning = false;
let isAppQuitting = false;
let isForceClosingWindow = false;

function getPlatformWindowOptions() {
  // On macOS we use `hiddenInset` so the native titlebar background is gone
  // and the traffic lights float over our custom ``.titlebar`` element,
  // which already reserves 72px on the left specifically for them.
  //
  // On Windows we ask Electron to hide the native titlebar text area while
  // leaving min/max/close buttons painted via `titleBarOverlay`.  The
  // overlay colours roughly match the light theme; the user toggling dark
  // mode will leave them as-is (the renderer only re-themes the HTML, not
  // the native overlay), which is acceptable for a non-primary platform.
  //
  // On Linux we leave the default frame — Linux WM decorations vary too
  // much to safely hide, and a double titlebar on Linux is acceptable per
  // the "Windows / Linux 至少不要壞掉" guidance.
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' };
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#fbf8ef',        // matches --mantle in styles.css
        symbolColor: '#1e1a0e',  // matches --text
        height: 44,              // matches --titlebar-h
      },
    };
  }
  return {};
}

function createWindow() {
  const state = readWindowState();

  mainWindow = new BrowserWindow({
    width:  state.width  || WINDOW_DEFAULTS.width,
    height: state.height || WINDOW_DEFAULTS.height,
    x: state.x,
    y: state.y,
    minWidth: WINDOW_DEFAULTS.minWidth,
    minHeight: WINDOW_DEFAULTS.minHeight,
    title: 'WhisperFlow Studio',
    icon: path.join(ELECTRON_APP_ROOT, 'assets', 'icon.png'),
    ...getPlatformWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Debounce save to avoid excessive writes during resize drag
  let _saveTimer = null;
  const debouncedSave = () => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => saveWindowState(mainWindow), 400);
  };
  mainWindow.on('resize', debouncedSave);
  mainWindow.on('move',   debouncedSave);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    if (isAppQuitting || isForceClosingWindow) return;
    if (!isRunning) return;
    e.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['繼續等待', '強制關閉'],
      defaultId: 0,
      cancelId: 0,
      title: 'WhisperFlow Studio',
      message: '轉錄正在進行中',
      detail: '強制關閉將會中斷目前的轉錄作業，確定要關閉嗎？',
    }).then(({ response }) => {
      if (response !== 1) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;

      isRunning = false;
      isForceClosingWindow = true;
      mainWindow.close();
    });
  });

  mainWindow.on('closed', () => {
    isForceClosingWindow = false;
    mainWindow = null;
  });
}

function setIsRunning(val) { isRunning = val; }

// ── Bootstrap ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Expose userData path to the path-resolver so it can flush Python
  // detection traces to disk when a resolution attempt fails.  Users can
  // send us this log when they hit "找不到 Python 3" and we can see
  // exactly which resolver step failed.
  process.env.WHISPERFLOW_USER_DATA_DIR = app.getPath('userData');

  if (process.platform === 'darwin') {
    const macIcon = nativeImage.createFromPath(path.join(ELECTRON_APP_ROOT, 'assets', 'icon-mac.png'));
    app.dock.setIcon(macIcon);
    app.setAboutPanelOptions({ icon: macIcon });
  }
  createWindow();
  registerHandlers(mainWindow, ELECTRON_APP_ROOT, readLocalSettings, writeLocalSettings, setIsRunning);
});

app.on('before-quit', () => {
  isAppQuitting = true;
  isRunning = false;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) {
    createWindow();
    registerHandlers(mainWindow, ELECTRON_APP_ROOT, readLocalSettings, writeLocalSettings, setIsRunning);
  }
});
