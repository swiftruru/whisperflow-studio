'use strict';

const { ipcMain, dialog, Notification, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { readConfig, writeConfig, getProfileList, copyProfileToActive } = require('./config-manager');
const { readConfigMetadata, getSupportedMediaExtensions } = require('./config-metadata');
const { runPreflight, validateSettingField } = require('./preflight-checker');
const { createQueueManager } = require('./queue-manager');
const { runScript, stopProcess, pauseProcess, resumeProcess } = require('./python-runner');
const { resolvePoetryPath } = require('./path-resolver');
const { ERROR_CODES, createAppError, normalizeUnknownError, toAppError } = require('./error-catalog');

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

  function sendQueueState(state) {
    mainWindow.webContents.send('queue:state-updated', state);
  }

  const queueManager = createQueueManager({
    configPath: path.join(PYTHON_DIR, 'config', 'config.json'),
    configMetadataPath: CONFIG_METADATA_PATH,
    onStateChange: sendQueueState,
  });

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
  ipcMain.handle('queue:get-state', () => queueManager.getState());
  ipcMain.handle('queue:retry-failed', () => queueManager.retryFailedJobs());
  ipcMain.handle('queue:clear-finished', () => queueManager.clearFinishedJobs());
  ipcMain.handle('queue:retry-job', (_event, jobId) => queueManager.retryJob(jobId));
  ipcMain.handle('queue:remove-job', (_event, jobId) => queueManager.removeJob(jobId));
  ipcMain.handle('queue:move-job', (_event, jobId, direction) => queueManager.moveJob(jobId, direction));

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

  function sendRunnerEvent(event) {
    mainWindow.webContents.send('runner:event', event);
  }

  function sendDone(code) {
    mainWindow.webContents.send('run:done', code);
  }

  function sendRunError(errorLike, fallback = {}) {
    const payload = (errorLike && (typeof errorLike === 'string' || errorLike.message || errorLike.code))
      ? toAppError(errorLike, fallback)
      : normalizeUnknownError(errorLike, fallback);

    mainWindow.webContents.send('run:error', payload);
    return payload;
  }

  ipcMain.on('run:scan', async (_event, rootPath) => {
    const { configPath } = getPaths();

    let effectiveRootPath = rootPath;
    if (!effectiveRootPath) {
      try {
        const cfg = readConfig(configPath);
        effectiveRootPath = cfg?.SETTING?.media_root_path || '';
      } catch (_) {}
    }

    const rootPathCheck = validateSettingField({
      key: 'media_root_path',
      value: effectiveRootPath,
      configMetadataPath: CONFIG_METADATA_PATH,
    });

    if (rootPathCheck.status === 'error') {
      sendRunError(rootPathCheck, {
        source: 'scan',
        suggestedAction: 'retry-scan',
      });
      sendDone(1);
      return;
    }

    try {
      sendLog(`[WhisperFlow] Scanning queue from: "${effectiveRootPath}"\n`);
      const snapshot = queueManager.scanMedia(effectiveRootPath);
      const { stats, currentJob, scanSummary } = snapshot;

      if (stats.total > 0 && currentJob) {
        sendLog(`[WhisperFlow] Found ${stats.total} media files without subtitles.\n`);
        sendLog(`[WhisperFlow] Next queued file: "${currentJob.fileName}"\n`);
      } else {
        sendLog('[WhisperFlow] No media files without subtitles were found.\n');
      }

      sendLog(`[WhisperFlow] Scan complete. Directories: ${scanSummary.scannedDirectories}, files: ${scanSummary.scannedFiles}.\n`);
      sendDone(0);
    } catch (error) {
      sendRunError(error, {
        code: ERROR_CODES.SCAN_FAILED,
        title: '媒體掃描失敗',
        message: '掃描媒體資料夾時發生錯誤。',
        suggestedAction: 'retry-scan',
        source: 'scan',
      });
      sendDone(1);
    }
  });

  ipcMain.on('run:cli', () => {
    const { whisperToolPath, scripts } = getPaths();
    const preflight = runPreflight(getPreflightContext());

    if (!preflight.ok) {
      sendRunError(
        preflight.blockingChecks[0] || createAppError({
          code: ERROR_CODES.PREFLIGHT_BLOCKED,
          title: '環境檢查未通過',
          message: 'Preflight failed. Please review your settings.',
          suggestedAction: 'rerun-preflight',
          source: 'run',
        }),
        {
          source: 'run',
        }
      );
      sendDone(1);
      return;
    }

    if (!whisperToolPath) {
      sendRunError(createAppError({
        code: ERROR_CODES.MISSING_WHISPER_TOOL_PATH,
        title: 'Whisper 工具路徑未設定',
        message: '請先在 Settings 指定 faster-whisper-webui 路徑。',
        suggestedAction: 'open-settings',
        actionPayload: { section: 'SETTING', key: 'whisper_faster_tool_path' },
        source: 'run',
      }));
      sendDone(1);
      return;
    }

    const poetryPath = resolvePoetryPath(getLocalSettings().poetryPath, CONFIG_METADATA_PATH);
    if (!poetryPath) {
      sendRunError(createAppError({
        code: ERROR_CODES.POETRY_NOT_FOUND,
        title: '找不到 Poetry',
        message: 'Poetry not found. Please set the Poetry path in settings.',
        suggestedAction: 'open-settings',
        actionPayload: { section: 'APP_SETTINGS', key: 'poetryPath' },
        source: 'run',
      }));
      sendDone(1);
      return;
    }

    const job = queueManager.startNextJob();
    if (!job) {
      sendLog('[WhisperFlow] No queued media files are ready for transcription.\n');
      sendDone(0);
      return;
    }

    let stderrBuffer = '';
    sendLog(`[WhisperFlow] Starting CLI transcription for "${job.fileName}"...\n`);

    runScript(
      poetryPath,
      scripts.cli,
      [],
      whisperToolPath,
      (text) => {
        sendLog(text);
        queueManager.handleRunnerOutput(text);
      },
      (err) => {
        stderrBuffer += err;
        sendLog(`[stderr] ${err}`);
        queueManager.handleRunnerOutput(err);
      },
      (code) => {
        if (code === -3) {
          queueManager.skipCurrentJob();
        } else if (code === -2) {
          queueManager.stopCurrentJob();
        } else {
          queueManager.finishCurrentJob(code, stderrBuffer.trim());
          if (code !== 0) {
            sendRunError(createAppError({
              code: ERROR_CODES.TRANSCRIPTION_FAILED,
              title: '轉錄失敗',
              message: '目前檔案的轉錄流程失敗。',
              details: stderrBuffer.trim() || `Process exited with code ${code}`,
              suggestedAction: 'retry-run',
              source: 'run',
            }));
          }
        }
        sendDone(code);
      },
      (event) => {
        queueManager.handleRunnerEvent(event);
        sendRunnerEvent(event);
      }
    );
  });

  ipcMain.on('run:pause', () => {
    const paused = pauseProcess();
    if (!paused) {
      sendRunError(createAppError({
        code: ERROR_CODES.RUNNER_PAUSE_FAILED,
        title: '無法暫停轉錄',
        message: 'Unable to pause the current transcription on this platform or there is no active job.',
        suggestedAction: 'dismiss-error',
        source: 'run',
      }));
      return;
    }

    queueManager.pauseCurrentJob();
    sendLog('[WhisperFlow] Process paused.\n');
  });

  ipcMain.on('run:resume', () => {
    const resumed = resumeProcess();
    if (!resumed) {
      sendRunError(createAppError({
        code: ERROR_CODES.RUNNER_RESUME_FAILED,
        title: '無法恢復轉錄',
        message: 'Unable to resume the current transcription because no paused job was found.',
        suggestedAction: 'dismiss-error',
        source: 'run',
      }));
      return;
    }

    queueManager.resumeCurrentJob();
    sendLog('[WhisperFlow] Process resumed.\n');
  });

  ipcMain.on('run:skip-current', () => {
    const skipped = stopProcess(-3);
    if (!skipped) {
      sendRunError(createAppError({
        code: ERROR_CODES.RUNNER_SKIP_FAILED,
        title: '無法跳過目前檔案',
        message: 'No active transcription is available to skip.',
        suggestedAction: 'dismiss-error',
        source: 'run',
      }));
      return;
    }

    sendLog('[WhisperFlow] Skipping current file...\n');
  });

  ipcMain.on('run:stop', () => {
    const stopped = stopProcess(-2);
    if (!stopped) {
      sendRunError(createAppError({
        code: ERROR_CODES.RUNNER_STOP_FAILED,
        title: '無法停止批次',
        message: 'No active transcription is running.',
        suggestedAction: 'dismiss-error',
        source: 'run',
      }));
      return;
    }

    sendLog('[WhisperFlow] Process stopped by user.\n');
  });
}

module.exports = { registerHandlers };
