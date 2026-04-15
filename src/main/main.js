'use strict';

const { app, BrowserWindow, nativeImage, dialog } = require('electron');

app.name = 'WhisperFlow Studio';
const path = require('path');
const fs = require('fs');
const { getAppRuntimeConfig } = require('./config-metadata');
const { registerHandlers } = require('./ipc-handlers');
const { initMainI18n, resolveLanguage, t } = require('./i18n');
const { registerLocaleIpcHandlers } = require('./locale-ipc');
const updater = require('./updater');
const {
  broadcastUpdaterEvent,
  registerUpdaterIpcHandlers,
} = require('./updater/updater-ipc');
const { setApplicationMenu } = require('./app-menu');

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
const { applyExtraPathPrefixes } = require('./env-path');
applyExtraPathPrefixes(APP_RUNTIME_CONFIG.extraPathPrefixes?.[process.platform] || []);

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

// Legacy settings keys that earlier versions wrote to settings.json but
// are no longer used.  Strip them on load so the Settings tab doesn't
// render stale fields (e.g. `poetryPath` — replaced by the bundled venv
// bootstrap in v1.4.0 and fully redundant since `pythonPath` alone is
// enough to kick off the first-run environment setup).
const LEGACY_SETTINGS_KEYS = ['poetryPath'];

function normalizeLocalSettings(data) {
  const merged = {
    ...cloneJson(getDefaultLocalSettings()),
    ...(data || {}),
  };
  for (const legacyKey of LEGACY_SETTINGS_KEYS) {
    delete merged[legacyKey];
  }
  return merged;
}

function readLocalSettings() {
  const defaults = normalizeLocalSettings();
  const settings = readJsonFile(LOCAL_SETTINGS_PATH, defaults);
  const normalized = normalizeLocalSettings(settings);

  const hadLegacyKey = settings && LEGACY_SETTINGS_KEYS.some((k) => k in settings);
  if (!fs.existsSync(LOCAL_SETTINGS_PATH) || hadLegacyKey) {
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
      buttons: [
        t('dialogs:closeWhileRunning.buttonWait'),
        t('dialogs:closeWhileRunning.buttonForce'),
      ],
      defaultId: 0,
      cancelId: 0,
      title: t('dialogs:closeWhileRunning.title'),
      message: t('dialogs:closeWhileRunning.message'),
      detail: t('dialogs:closeWhileRunning.detail'),
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
app.whenReady().then(async () => {
  // Expose userData path to the path-resolver so it can flush Python
  // detection traces to disk when a resolution attempt fails.  Users can
  // send us this log when they hit "找不到 Python 3" and we can see
  // exactly which resolver step failed.
  process.env.WHISPERFLOW_USER_DATA_DIR = app.getPath('userData');

  // Initialize main-process i18n before any IPC handler or preflight
  // check runs, so every user-facing string is localized from the very
  // first frame.  Language resolution precedence:
  //   settings.json :: uiLanguage (if 'zh-TW' | 'en') → explicit
  //   settings.json :: uiLanguage === 'auto' or missing → app.getLocale()
  //   Any zh-* → zh-TW, any en-* → en, everything else → zh-TW
  const persistedSettings = readLocalSettings() || {};
  const resolvedLang = resolveLanguage(persistedSettings.uiLanguage, app.getLocale());
  await initMainI18n({
    localesRoot: path.join(APP_SOURCE_ROOT, 'locales'),
    initialLanguage: resolvedLang,
  });
  registerLocaleIpcHandlers({ readLocalSettings, writeLocalSettings });

  if (process.platform === 'darwin') {
    const macIcon = nativeImage.createFromPath(path.join(ELECTRON_APP_ROOT, 'assets', 'icon-mac.png'));
    app.dock.setIcon(macIcon);
    app.setAboutPanelOptions({ icon: macIcon });
  }
  createWindow();
  registerHandlers(mainWindow, ELECTRON_APP_ROOT, readLocalSettings, writeLocalSettings, setIsRunning);

  // ── Updater wiring ─────────────────────────────────────────────────────
  // The updater lives in its own module and only needs three hooks:
  //   1. A broadcast channel so it can push updater:* events to the
  //      renderer (via updater-ipc.js :: broadcastUpdaterEvent)
  //   2. Read/write access to settings.json for the "skip this
  //      version" flag, which it gets via the existing helpers
  //   3. IPC registration so renderer components can trigger manual
  //      checks, skip, and install actions
  //
  // After init, the orchestrator itself schedules a 5-second passive
  // check; we don't have to call checkForUpdates() explicitly here.
  registerUpdaterIpcHandlers();
  updater.initUpdater({
    readSettings: readLocalSettings,
    writeSettings: writeLocalSettings,
    broadcast: broadcastUpdaterEvent,
  });

  // Install the custom application menu (Check for Updates…, etc.).
  // The "Open About" click tells the renderer to switch to the About
  // tab — we just emit a dedicated channel and the renderer handles
  // it via its own listener in about-panel.js / index.js.
  setApplicationMenu({
    onCheckForUpdates: () => {
      updater.checkForUpdates({ manual: true }).catch((err) => {
        console.error('[menu] manual check failed:', err);
      });
    },
    onOpenAbout: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('menu:open-about');
      }
    },
  });
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
