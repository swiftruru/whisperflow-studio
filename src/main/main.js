'use strict';

const { app, BrowserWindow, nativeImage, dialog } = require('electron');

app.name = 'WhisperFlow Studio';
const path = require('path');
const fs = require('fs');
const { registerHandlers } = require('./ipc-handlers');

// ── Path Resolution ───────────────────────────────────────────────────────────
// In development:  ELECTRON_APP_ROOT = <project>/
// In packaged app: ELECTRON_APP_ROOT = <app>.app/Contents/Resources/
//   (python/ and bridge/ are placed there via extraResources in electron-builder.yml)
const ELECTRON_APP_ROOT = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, '..', '..');

// settings.json: portable in dev (lives with the project), userData in packaged build.
const LOCAL_SETTINGS_PATH = app.isPackaged
  ? path.join(app.getPath('userData'), 'settings.json')
  : path.join(path.resolve(__dirname, '..', '..'), 'settings.json');

function readLocalSettings() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_SETTINGS_PATH, 'utf-8'));
  } catch (_) {
    return { poetryPath: null };
  }
}

function writeLocalSettings(data) {
  fs.writeFileSync(LOCAL_SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Window State ──────────────────────────────────────────────────────────────
const WINDOW_STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, 'utf-8'));
  } catch (_) {
    return { width: 1100, height: 720 };
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
    width:  state.width  || 1100,
    height: state.height || 720,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 560,
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
