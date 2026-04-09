'use strict';

const { ipcMain, dialog, Notification, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { readConfig, writeConfig, getProfileList, copyProfileToActive } = require('./config-manager');
const { readConfigMetadata, getSupportedMediaExtensions } = require('./config-metadata');
const { runPreflight, validateSettingField } = require('./preflight-checker');
const { runScript, stopProcess } = require('./python-runner');
const { resolvePoetryPath } = require('./path-resolver');

function registerHandlers(mainWindow, ELECTRON_APP_ROOT, getLocalSettings, saveLocalSettings, setIsRunning) {
  const PYTHON_DIR = path.join(ELECTRON_APP_ROOT, 'python');
  const CONFIG_METADATA_PATH = path.join(PYTHON_DIR, 'config', 'config.metadata.json');

  // All paths are relative to the bundled python/ directory.
  // whisperToolPath is read from python/config/config.json and used as the
  // Poetry cwd so we reuse the faster-whisper-webui environment.
  // (reuses faster-whisper-webui's env; our scripts need only stdlib).
  function getPaths() {
    const configPath = path.join(PYTHON_DIR, 'config', 'config.json');

    let whisperToolPath = '';
    try {
      const cfg = readConfig(configPath);
      whisperToolPath = cfg?.SETTING?.whisper_faster_tool_path || '';
    } catch (_) {}

    return {
      configPath,
      configDir:       path.join(PYTHON_DIR, 'config'),
      whisperToolPath,
      scripts: {
        scan: path.join(PYTHON_DIR, 'config_setting.py'),
        cli:  path.join(ELECTRON_APP_ROOT, 'bridge', 'run_cli.py'),
      },
    };
  }

  function getPreflightContext() {
    return {
      electronAppRoot: ELECTRON_APP_ROOT,
      configMetadataPath: CONFIG_METADATA_PATH,
      getLocalSettings,
    };
  }

  // ── Running State ─────────────────────────────────────────────────────────
  ipcMain.on('app:set-running', (_event, val) => setIsRunning(val));

  // ── System Notification ───────────────────────────────────────────────────
  ipcMain.on('app:notify', (_event, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  });

  // ── Config ────────────────────────────────────────────────────────────────

  ipcMain.handle('config:read', () => {
    return readConfig(path.join(PYTHON_DIR, 'config', 'config.json'));
  });

  ipcMain.handle('config:metadata:read', () => {
    return readConfigMetadata(CONFIG_METADATA_PATH);
  });

  ipcMain.handle('config:write', (_event, configObj) => {
    writeConfig(path.join(PYTHON_DIR, 'config', 'config.json'), configObj);
    return true;
  });

  ipcMain.handle('config:profiles:list', () => {
    return getProfileList(path.join(PYTHON_DIR, 'config'));
  });

  ipcMain.handle('config:profiles:load', (_event, profileConfigPath) => {
    const configPath = path.join(PYTHON_DIR, 'config', 'config.json');
    copyProfileToActive(profileConfigPath, configPath);
    return readConfig(configPath);
  });

  // ── File System Dialogs ───────────────────────────────────────────────────

  ipcMain.handle('fs:browse-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('fs:browse-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Media Files', extensions: getSupportedMediaExtensions(CONFIG_METADATA_PATH) }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('fs:browse-any-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('shell:show-in-folder', (_event, filePath) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('fs:save-log', async (_event, text) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Console Log',
      defaultPath: `whisperflow-log-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`,
      filters: [{ name: 'Text Files', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, text, 'utf-8');
    return true;
  });

  // ── App Settings (portable settings.json) ────────────────────────────────

  ipcMain.handle('appsettings:read', () => getLocalSettings());
  ipcMain.handle('appsettings:write', (_event, data) => saveLocalSettings(data));
  ipcMain.handle('app:run-preflight', () => runPreflight(getPreflightContext()));
  ipcMain.handle('app:validate-setting-field', (_event, payload = {}) => {
    return validateSettingField({
      ...payload,
      configMetadataPath: CONFIG_METADATA_PATH,
    });
  });

  // ── Transcription History ─────────────────────────────────────────────────
  const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');

  ipcMain.handle('history:read', () => {
    try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')); }
    catch (_) { return []; }
  });

  ipcMain.handle('history:write', (_event, entries) => {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries, null, 2), 'utf-8');
    return true;
  });

  // ── Process Runners ───────────────────────────────────────────────────────

  function sendLog(text) {
    mainWindow.webContents.send('log:data', text);
  }

  function sendDone(code) {
    mainWindow.webContents.send('run:done', code);
  }

  function sendRunError(msg) {
    mainWindow.webContents.send('run:error', msg);
  }

  ipcMain.on('run:scan', (_event, rootPath) => {
    const { configPath, whisperToolPath, scripts } = getPaths();
    const preflight = runPreflight(getPreflightContext());

    if (!preflight.ok) {
      sendRunError(preflight.blockingChecks[0]?.message || 'Preflight failed. Please review your settings.');
      sendDone(1);
      return;
    }

    if (!whisperToolPath) {
      sendLog('[WhisperFlow] Error: whisper_faster_tool_path not set. Please configure it in Settings.\n');
      sendDone(1);
      return;
    }

    const poetryPath = resolvePoetryPath(getLocalSettings().poetryPath, CONFIG_METADATA_PATH);
    if (!poetryPath) {
      sendRunError('Poetry not found. Please set the Poetry path in settings.');
      return;
    }

    // Always pass --root_path to avoid config_setting.py falling into interactive input().
    let effectiveRootPath = rootPath;
    if (!effectiveRootPath) {
      try {
        const cfg = readConfig(configPath);
        effectiveRootPath = cfg?.SETTING?.media_root_path || '';
      } catch (_) {}
    }

    if (!effectiveRootPath) {
      sendLog('[WhisperFlow] Error: No media root path set. Please select a directory first.\n');
      sendDone(1);
      return;
    }

    const args = ['--root_path', effectiveRootPath];
    sendLog('[WhisperFlow] Starting directory scan...\n');

    runScript(
      poetryPath,
      scripts.scan,
      args,
      whisperToolPath,
      sendLog,
      (err) => sendLog(`[stderr] ${err}`),
      (code) => sendDone(code)
    );
  });

  ipcMain.on('run:cli', () => {
    const { whisperToolPath, scripts } = getPaths();
    const preflight = runPreflight(getPreflightContext());

    if (!preflight.ok) {
      sendRunError(preflight.blockingChecks[0]?.message || 'Preflight failed. Please review your settings.');
      sendDone(1);
      return;
    }

    if (!whisperToolPath) {
      sendLog('[WhisperFlow] Error: whisper_faster_tool_path not set. Please configure it in Settings.\n');
      sendDone(1);
      return;
    }

    const poetryPath = resolvePoetryPath(getLocalSettings().poetryPath, CONFIG_METADATA_PATH);
    if (!poetryPath) {
      sendRunError('Poetry not found. Please set the Poetry path in settings.');
      return;
    }

    sendLog('[WhisperFlow] Starting CLI transcription...\n');

    runScript(
      poetryPath,
      scripts.cli,
      [],
      whisperToolPath,
      sendLog,
      (err) => sendLog(`[stderr] ${err}`),
      (code) => sendDone(code)
    );
  });

  ipcMain.on('run:stop', () => {
    stopProcess();
    sendLog('[WhisperFlow] Process stopped by user.\n');
    mainWindow.webContents.send('run:done', -2);
  });
}

module.exports = { registerHandlers };
