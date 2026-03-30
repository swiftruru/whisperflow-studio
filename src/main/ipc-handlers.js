'use strict';

const { ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { readConfig, writeConfig, getProfileList, copyProfileToActive } = require('./config-manager');
const { runScript, stopProcess } = require('./python-runner');
const { resolvePoetryPath } = require('./path-resolver');

const SUPPORTED_MEDIA_EXTENSIONS = [
  'mp4', 'mov', 'mkv', 'avi', 'ts', 'mjpeg', 'mpeg', 'f4v', 'flv',
  'm2t', 'm2ts', 'm2v', '3gp', '3g2', 'mp3', 'wav', 'ogg', 'flac',
  'm4a', 'm4v', 'aiff',
];

function registerHandlers(mainWindow, ELECTRON_APP_ROOT, getLocalSettings, saveLocalSettings, setIsRunning) {
  const PYTHON_DIR = path.join(ELECTRON_APP_ROOT, 'python');

  // All paths are relative to the bundled python/ directory.
  // whisperToolPath is read from config.ini and used as the Poetry cwd
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
      filters: [{ name: 'Media Files', extensions: SUPPORTED_MEDIA_EXTENSIONS }],
    });
    return result.canceled ? null : result.filePaths[0];
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

    if (!whisperToolPath) {
      sendLog('[WhisperFlow] Error: whisper_faster_tool_path not set. Please configure it in Settings.\n');
      sendDone(1);
      return;
    }

    const poetryPath = resolvePoetryPath(getLocalSettings().poetryPath);
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

    if (!whisperToolPath) {
      sendLog('[WhisperFlow] Error: whisper_faster_tool_path not set. Please configure it in Settings.\n');
      sendDone(1);
      return;
    }

    const poetryPath = resolvePoetryPath(getLocalSettings().poetryPath);
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
