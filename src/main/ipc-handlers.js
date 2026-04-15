'use strict';

const { ipcMain, dialog, Notification, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { readConfig, writeConfig, getProfileList, copyProfileToActive } = require('./config-manager');
const { readConfigMetadata, getSupportedMediaExtensions } = require('./config-metadata');
const { runPreflight, validateSettingField } = require('./preflight-checker');
const { createQueueManager } = require('./queue-manager');
const { runScript, stopProcess, pauseProcess, resumeProcess } = require('./python-runner');
const {
  getVenvRoot,
  resolveBundledPython,
  resolveSystemPython,
} = require('./path-resolver');
const { initializeBundledVenv, isVenvInitialized } = require('./venv-installer');
const { ERROR_CODES, createAppError, normalizeUnknownError, toAppError } = require('./error-catalog');

let activeQueueManager = null;
let beforeQuitPersistenceHookRegistered = false;

function registerHandlers(mainWindow, ELECTRON_APP_ROOT, getLocalSettings, saveLocalSettings, setIsRunning) {
  const PYTHON_DIR = path.join(ELECTRON_APP_ROOT, 'python');
  const CONFIG_METADATA_PATH = path.join(PYTHON_DIR, 'config', 'config.metadata.json');
  const USER_DATA_DIR = app.getPath('userData');
  const QUEUE_STATE_PATH = path.join(USER_DATA_DIR, 'queue-state.json');

  // The bundled venv lives at one of two places depending on whether we're
  // packaged: `<project>/python/.venv` in dev (writable, easy to inspect),
  // or `<userData>/.venv` in a packaged build (the only writable spot
  // available on macOS / Windows / Linux installers).  Computed once here
  // and threaded through every helper that needs it.
  const VENV_ROOT = getVenvRoot({
    electronAppRoot: ELECTRON_APP_ROOT,
    isPackaged: app.isPackaged,
    userDataDir: USER_DATA_DIR,
    configMetadataPath: CONFIG_METADATA_PATH,
  });
  const REQUIREMENTS_PATH = path.join(PYTHON_DIR, 'requirements.txt');

  // All paths are relative to the bundled python/ directory.  The CLI and
  // scan scripts are spawned via the in-app .venv, so there's no external
  // Python project dependency anymore.
  function getPaths() {
    return {
      configPath:      path.join(PYTHON_DIR, 'config', 'config.json'),
      configDir:       path.join(PYTHON_DIR, 'config'),
      pythonDir:       PYTHON_DIR,
      venvRoot:        VENV_ROOT,
      scripts: {
        scan: path.join(PYTHON_DIR, 'config_setting.py'),
        cli:  path.join(ELECTRON_APP_ROOT, 'bridge', 'run_cli.py'),
      },
    };
  }

  // Compute the cross-platform managed models directory and persist it to
  // config.json so the Python side (ModelManager) reads a single source of
  // truth.  Called lazily when the renderer asks for config or kicks off
  // a run.
  function ensureModelsDirInConfig() {
    const { configPath } = getPaths();
    let cfg;
    try {
      cfg = readConfig(configPath);
    } catch (_) {
      return null;
    }

    const existing = cfg?.SETTING?.models_dir?.trim?.() || '';
    if (existing) return existing;

    const defaultModelsDir = path.join(app.getPath('userData'), 'models');
    cfg.SETTING = cfg.SETTING || {};
    cfg.SETTING.models_dir = defaultModelsDir;
    try {
      fs.mkdirSync(defaultModelsDir, { recursive: true });
      writeConfig(configPath, cfg);
    } catch (_) {
      // Non-fatal: the Python side will fall back to its own default.
    }
    return defaultModelsDir;
  }

  function getPreflightContext() {
    return {
      electronAppRoot: ELECTRON_APP_ROOT,
      venvRoot: VENV_ROOT,
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
    queueStatePath: QUEUE_STATE_PATH,
    onStateChange: sendQueueState,
  });

  activeQueueManager = queueManager;

  if (!beforeQuitPersistenceHookRegistered) {
    app.on('before-quit', () => {
      activeQueueManager?.flushState?.();
    });
    beforeQuitPersistenceHookRegistered = true;
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
    const { scripts, pythonDir, venvRoot } = getPaths();
    ensureModelsDirInConfig();
    const preflight = runPreflight(getPreflightContext());

    // Preflight errors block; the venv-not-initialized warning does NOT (we
    // let the user trigger initialisation via a separate IPC, and block
    // later if they still try to run without it).
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

    const venvPython = resolveBundledPython(venvRoot);
    if (!venvPython || !isVenvInitialized(venvRoot)) {
      sendRunError(createAppError({
        code: ERROR_CODES.VENV_NOT_INITIALIZED,
        title: 'Python 虛擬環境尚未建立',
        message: '第一次執行前請先建立虛擬環境（會自動安裝依賴，約數百 MB）。',
        suggestedAction: 'initialize-venv',
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
    let lastStructuredError = null;
    sendLog(`[WhisperFlow] Starting CLI transcription for "${job.fileName}"...\n`);

    runScript(
      venvPython,
      scripts.cli,
      [],
      pythonDir,
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
            // Prefer the actual exception message that whisperflow's
            // EventEmitter sent us via [WhisperFlowEvent], so the banner
            // shows the real cause (e.g. "[Errno 2] No such file or
            // directory: 'ffprobe'") instead of a hardcoded "轉錄失敗".
            // Fall back to stderr buffer or exit code for unstructured
            // crashes (segfaults, OOM kills, etc).
            const realMessage = lastStructuredError?.message
              || stderrBuffer.trim()
              || `Process exited with code ${code}`;
            sendRunError(createAppError({
              code: ERROR_CODES.TRANSCRIPTION_FAILED,
              title: '轉錄失敗',
              message: realMessage,
              details: lastStructuredError?.meta?.reason
                ? `${lastStructuredError.meta.reason}: ${realMessage}\n\n${stderrBuffer.trim()}`.trim()
                : (stderrBuffer.trim() || realMessage),
              suggestedAction: 'retry-run',
              source: 'run',
            }));
          }
        }
        sendDone(code);
      },
      (event) => {
        if (event && event.type === 'error') {
          lastStructuredError = event;
        }
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

    queueManager.markSkippingCurrent();
    sendLog('[WhisperFlow] Skipping current file. Waiting for current process to exit...\n');
  });

  // ── Bundled venv initialisation ──────────────────────────────────────────

  ipcMain.handle('venv:status', () => {
    const { venvRoot } = getPaths();
    const venvPython = resolveBundledPython(venvRoot);
    return {
      initialized: Boolean(venvPython) && isVenvInitialized(venvRoot),
      pythonPath: venvPython,
      venvRoot,
    };
  });

  ipcMain.handle('venv:initialize', async () => {
    const { venvRoot } = getPaths();
    const systemPython = resolveSystemPython(getLocalSettings()?.pythonPath, CONFIG_METADATA_PATH);
    if (!systemPython) {
      throw new Error('No system Python 3 interpreter found. Please install Python 3.10+ or set one in Settings.');
    }

    // Make sure models_dir is in config.json BEFORE the venv finishes — that
    // way, when the renderer re-reads config after the install completes,
    // the Models tab and Settings tab both see the auto-populated path.
    ensureModelsDirInConfig();

    try {
      await initializeBundledVenv({
        systemPython,
        venvRoot,
        requirementsPath: REQUIREMENTS_PATH,
        onLog: (text) => sendLog(text),
      });
      return { ok: true };
    } catch (error) {
      sendRunError(createAppError({
        code: ERROR_CODES.VENV_INIT_FAILED,
        title: '虛擬環境建立失敗',
        message: error.message || 'Failed to initialize the bundled Python virtual environment.',
        details: error.stack || '',
        source: 'venv',
      }));
      throw error;
    }
  });

  // ── Model Manager ────────────────────────────────────────────────────────
  //
  // These delegate to `whisperflow.cli` sub-commands running inside the
  // bundled venv.  Each call is a one-shot child process whose JSON output
  // is parsed and returned to the renderer.

  function runVenvPython(args) {
    return new Promise((resolve, reject) => {
      const { pythonDir, venvRoot } = getPaths();
      const venvPython = resolveBundledPython(venvRoot);
      if (!venvPython) {
        reject(new Error('Bundled Python venv is not initialised.'));
        return;
      }

      const { spawn } = require('child_process');
      const child = spawn(venvPython, args, { cwd: pythonDir });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `python exited with code ${code}`));
      });
      child.on('error', reject);
    });
  }

  ipcMain.handle('models:list', async () => {
    ensureModelsDirInConfig();
    const stdout = await runVenvPython(['-m', 'whisperflow.cli', '--list-models']);
    return JSON.parse(stdout);
  });

  ipcMain.handle('models:download', async (_event, name) => {
    ensureModelsDirInConfig();
    const stdout = await runVenvPython(['-m', 'whisperflow.cli', '--download-model', name]);
    return JSON.parse(stdout);
  });

  ipcMain.handle('models:delete', async (_event, name) => {
    ensureModelsDirInConfig();
    const stdout = await runVenvPython(['-m', 'whisperflow.cli', '--delete-model', name]);
    return JSON.parse(stdout);
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

    queueManager.markStoppingCurrent();
    sendLog('[WhisperFlow] Stopping current batch. Waiting for current process to exit...\n');
  });
}

module.exports = { registerHandlers };
