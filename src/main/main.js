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
const { initTray } = require('./tray');

// E2E mode: set WHISPERFLOW_E2E=1 to suppress side effects that make
// Playwright tests flaky (auto-updater popping a dialog, tray icon
// polluting the menubar). Optionally pass WHISPERFLOW_E2E_USERDATA=<dir>
// to redirect userData so tests don't touch real settings.json. The flag
// has zero effect on a normal launch.
const IS_E2E = process.env.WHISPERFLOW_E2E === '1';
if (IS_E2E && process.env.WHISPERFLOW_E2E_USERDATA) {
  app.setPath('userData', process.env.WHISPERFLOW_E2E_USERDATA);
}

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
// In E2E mode also pin settings.json to userData so the test fixture's
// pre-seeded file (uiLanguage='en', trayEnabled=false, etc.) is the one
// main.js actually reads — without this branch, dev-mode would still
// read the developer's portable settings.json at the project root and
// the locale-pinning would never take effect.
const LOCAL_SETTINGS_PATH = (app.isPackaged || IS_E2E)
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
let isAppQuitting = false;
let isForceClosingWindow = false;

// ── Busy-reason tracking ─────────────────────────────────────────────────────
// Any long-running operation that the user would NOT want to be silently
// interrupted by a window close registers itself here.  The close-guard
// dialog consults this set and, if non-empty, asks the user to confirm
// before tearing down the window.  Reasons are opaque strings — callers
// pick whatever makes sense ('transcription', 'model-download:large-v2',
// 'venv-init', 'pm-install:ffmpeg', ...) — and the close dialog picks the
// first one to show a localized message for.
//
// The priority order below decides which reason shows up in the confirm
// dialog when multiple tasks are running at once (e.g. a model download
// triggered during a transcription).  Transcription first because it's
// the most expensive to lose; model downloads second; everything else
// generic.
const BUSY_PRIORITY = ['transcription', 'model-download', 'venv-init', 'pm-install'];
const busyReasons = new Set();

function addBusyReason(reason) {
  if (typeof reason === 'string' && reason) busyReasons.add(reason);
}

function removeBusyReason(reason) {
  busyReasons.delete(reason);
}

function isBusy() {
  return busyReasons.size > 0;
}

/**
 * Pick the highest-priority busy reason currently registered and return
 * an object with its bare kind + optional subject (parsed from
 * `kind:subject` notation) so the dialog can render a specific message.
 * Example: `model-download:large-v2` → { kind: 'model-download', subject: 'large-v2' }.
 */
function getPrimaryBusyReason() {
  if (busyReasons.size === 0) return null;
  const reasons = Array.from(busyReasons);
  for (const kind of BUSY_PRIORITY) {
    const hit = reasons.find((r) => r === kind || r.startsWith(`${kind}:`));
    if (hit) {
      const colonIdx = hit.indexOf(':');
      return {
        kind,
        subject: colonIdx >= 0 ? hit.slice(colonIdx + 1) : '',
      };
    }
  }
  // Unknown reason not in our priority list — still treat as busy.
  return { kind: reasons[0], subject: '' };
}

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
    // Always use light-theme overlay colours to match the default
    // light theme.  Electron doesn't repaint titleBarOverlay when
    // the user toggles the in-app theme (the renderer only
    // re-themes the HTML, not the native overlay), so this is
    // always the boot-time colour — a user who flips to dark mode
    // still sees the cream overlay until next launch.
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#fbf8ef',        // matches --mantle (light)
        symbolColor: '#1e1a0e',  // matches --text (light)
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
    // Set the Electron-level window background to the light-theme
    // cream so the first frame drawn before our HTML loads is never
    // the OS default white/black.  We always default to light on
    // first launch (theme-boot.js does the same); returning users
    // who toggled to dark via the in-app toggle will see a brief
    // cream flash before the renderer's synchronous theme-boot.js
    // applies dark CSS — acceptable tradeoff for the simple code
    // path, and it only lasts one paint frame.
    backgroundColor: '#fbf8ef',
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

  // Drain any file paths that arrived via file-association events
  // before the window existed (macOS `open-file`, Windows argv).
  mainWindow.webContents.on('did-finish-load', () => {
    flushOpenFiles();
  });

  mainWindow.on('close', (e) => {
    if (isAppQuitting || isForceClosingWindow) return;
    if (!isBusy()) return;
    e.preventDefault();

    // Pick a specific message based on the highest-priority busy
    // reason currently registered — transcription > model download >
    // venv init > pm install.  Falls back to a generic "task running"
    // message for any reason we don't have a tailored string for.
    const primary = getPrimaryBusyReason();
    const reasonKind = primary?.kind || 'transcription';
    const reasonMessageKey = `dialogs:closeWhileBusy.reasons.${reasonKind}`;
    const message = t(reasonMessageKey, {
      subject: primary?.subject || '',
      defaultValue: t('dialogs:closeWhileBusy.reasons.generic'),
    });

    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: [
        t('dialogs:closeWhileBusy.buttonWait'),
        t('dialogs:closeWhileBusy.buttonForce'),
      ],
      defaultId: 0,
      cancelId: 0,
      title: t('dialogs:closeWhileBusy.title'),
      message,
      detail: t('dialogs:closeWhileBusy.detail'),
    }).then(({ response }) => {
      if (response !== 1) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;

      // Clear all busy reasons — the user has acknowledged they're
      // force-closing and any in-flight work is about to be killed
      // by process exit anyway.
      busyReasons.clear();
      isForceClosingWindow = true;
      mainWindow.close();
    });
  });

  mainWindow.on('closed', () => {
    isForceClosingWindow = false;
    mainWindow = null;
  });
}

// Backwards-compatible shim for the renderer's `app:set-running`
// IPC: translates the boolean into the new busy-reason set so the
// close dialog covers transcription too.  New code paths (model
// download, venv init, pm install) call addBusyReason / removeBusyReason
// directly from ipc-handlers.js instead.
function setIsRunning(val) {
  if (val) addBusyReason('transcription');
  else removeBusyReason('transcription');
}

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

  // ── Download state hydration ──────────────────────────────────────
  const downloadState = require('./download-state');
  downloadState.configure({
    statePath: path.join(app.getPath('userData'), 'download-state.json'),
    busyTracker: { addBusyReason, removeBusyReason },
  });
  downloadState.hydrate();

  if (process.platform === 'darwin') {
    const macIcon = nativeImage.createFromPath(path.join(ELECTRON_APP_ROOT, 'assets', 'icon-mac.png'));
    app.dock.setIcon(macIcon);
    app.setAboutPanelOptions({ icon: macIcon });
  }
  createWindow();
  registerHandlers(
    mainWindow,
    ELECTRON_APP_ROOT,
    readLocalSettings,
    writeLocalSettings,
    setIsRunning,
    { addBusyReason, removeBusyReason },
  );

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
  if (!IS_E2E) {
    updater.initUpdater({
      readSettings: readLocalSettings,
      writeSettings: writeLocalSettings,
      broadcast: broadcastUpdaterEvent,
    });
  }

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

  // Tray icon + global shortcuts (opt-out via settings.json :: trayEnabled).
  // Default-on so power users get the menubar affordance without fiddling.
  // Tray menu labels reflect the language active at boot; users flipping
  // the UI-language toggle at runtime will see the updated labels on the
  // next app launch (main-process i18next already switches correctly —
  // rebuilding the Menu is the cheap-but-deferred part).
  const trayEnabled = persistedSettings.trayEnabled !== false && !IS_E2E;
  if (trayEnabled) {
    initTray({
      mainWindow,
      electronAppRoot: ELECTRON_APP_ROOT,
      t,
    });
  }
});

app.on('before-quit', () => {
  isAppQuitting = true;
  // Clear every busy reason so the close handler doesn't re-prompt
  // the user when they've already confirmed quit via the menu.
  busyReasons.clear();
  // Synchronously flush download state to disk so a reboot picks
  // up the latest progress / status of any in-flight download.
  require('./download-state').shutdown();
});

app.on('will-quit', () => {
  // Release all global shortcuts so the next launch (or other apps)
  // can re-register them cleanly.
  const { globalShortcut } = require('electron');
  try { globalShortcut.unregisterAll(); } catch (_) {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) {
    createWindow();
    registerHandlers(
    mainWindow,
    ELECTRON_APP_ROOT,
    readLocalSettings,
    writeLocalSettings,
    setIsRunning,
    { addBusyReason, removeBusyReason },
  );
  }
});

// ── File-association handlers ─────────────────────────────────────────────
// Queue pending file paths that arrive before the renderer is ready (via
// `open-file` events on macOS, or argv on Windows / Linux) — we drain
// them into the queue manager right after the BrowserWindow loads.
const _pendingOpenFiles = [];
function _enqueuePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;
  } catch (_) { return; }
  _pendingOpenFiles.push(filePath);
  flushOpenFiles();
}

function flushOpenFiles() {
  if (_pendingOpenFiles.length === 0) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.webContents || mainWindow.webContents.isLoading()) return;
  const paths = _pendingOpenFiles.splice(0);
  mainWindow.webContents.send('file-association:open', paths);
  mainWindow.show();
  mainWindow.focus();
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  _enqueuePath(filePath);
});

// On Windows/Linux the OS passes the path as an argv.  Filter out flags
// and non-existent entries so the Electron CLI args don't confuse the
// queue.  This runs once per launch; second-instance path below handles
// later double-click events.
for (const arg of process.argv.slice(1)) {
  if (typeof arg === 'string' && !arg.startsWith('-')) {
    _enqueuePath(arg);
  }
}

// single-instance lock so a second double-click forwards the path to
// the already-running window instead of launching a duplicate.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    for (const arg of argv.slice(1)) {
      if (typeof arg === 'string' && !arg.startsWith('-')) {
        _enqueuePath(arg);
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
