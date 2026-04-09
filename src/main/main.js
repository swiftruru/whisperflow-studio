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
// macOS GUI apps don't inherit the user's shell PATH. Prepend common install
// locations so ffprobe, ffmpeg, poetry, and other tools are always findable,
// regardless of how many subprocess layers deep they're called from.
if (process.platform === 'darwin') {
  const extra = APP_RUNTIME_CONFIG.macPathPrefixes || [];
  const current = (process.env.PATH || '').split(path.delimiter);
  const merged = [...new Set([...extra, ...current])].join(path.delimiter);
  process.env.PATH = merged;
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
      if (response === 1) {
        isRunning = false;
        mainWindow.close();
      }
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setIsRunning(val) { isRunning = val; }

// ── Bootstrap ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    const macIcon = nativeImage.createFromPath(path.join(ELECTRON_APP_ROOT, 'assets', 'icon-mac.png'));
    app.dock.setIcon(macIcon);
    app.setAboutPanelOptions({ icon: macIcon });
  }
  createWindow();
  registerHandlers(mainWindow, ELECTRON_APP_ROOT, readLocalSettings, writeLocalSettings, setIsRunning);
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
