'use strict';

const { ipcMain, dialog, Notification, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  readConfig,
  writeConfig,
  getProfileList,
  copyProfileToActive,
  createProfile: createProfileFs,
  renameProfile: renameProfileFs,
  deleteProfile: deleteProfileFs,
} = require('./config-manager');
const { readConfigMetadata, getSupportedMediaExtensions } = require('./config-metadata');
const { listChangelogEntries, readChangelogEntry } = require('./changelog');
const { collectDiagnostics, formatDiagnosticsAsText } = require('./diagnostics');
const { readTranscriptForMedia, hasTranscriptForMedia } = require('./transcript-reader');
const { runPreflight, validateSettingField } = require('./preflight-checker');
const { createQueueManager } = require('./queue-manager');
const { runScript, stopProcess, pauseProcess, resumeProcess } = require('./python-runner');
const {
  getVenvRoot,
  resolveBundledPython,
  resolveSystemPython,
} = require('./path-resolver');
const { initializeBundledVenv, isVenvInitialized } = require('./venv-installer');
const { detectAvailableManagers, installPackage, cancelActiveInstall } = require('./package-manager');
const { refreshSystemPathFromRegistry } = require('./env-path');
const { ERROR_CODES, createAppError, normalizeUnknownError, toAppError } = require('./error-catalog');
const { t } = require('./i18n');

let activeQueueManager = null;
let beforeQuitPersistenceHookRegistered = false;

function registerHandlers(
  mainWindow,
  ELECTRON_APP_ROOT,
  getLocalSettings,
  saveLocalSettings,
  setIsRunning,
  busyTracker = {},
) {
  // `busyTracker` is the pair of helpers main.js exports so that any
  // long-running IPC handler here can register itself as "busy" and
  // participate in the close-window confirm dialog.  We fall back to
  // no-op shims when the caller didn't pass them so unit tests and
  // older call sites keep working.
  const addBusyReason = typeof busyTracker.addBusyReason === 'function'
    ? busyTracker.addBusyReason
    : () => {};
  const removeBusyReason = typeof busyTracker.removeBusyReason === 'function'
    ? busyTracker.removeBusyReason
    : () => {};
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

  ipcMain.handle('config:profiles:create', (_event, name) => {
    return createProfileFs(path.join(PYTHON_DIR, 'config'), name);
  });

  ipcMain.handle('config:profiles:rename', (_event, payload = {}) => {
    return renameProfileFs(path.join(PYTHON_DIR, 'config'), payload.oldName, payload.newName);
  });

  ipcMain.handle('config:profiles:delete', (_event, name) => {
    return deleteProfileFs(path.join(PYTHON_DIR, 'config'), name);
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

  // Open a directory directly (not its parent).  Used by the Models
  // tab's "open folder" button next to the models_dir path — we want
  // Finder/Explorer to drop the user *inside* the folder rather than
  // revealing it in its parent like `showItemInFolder` does.
  ipcMain.handle('shell:open-path', async (_event, dirPath) => {
    if (!dirPath) return '';
    return shell.openPath(dirPath);
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
  ipcMain.handle('app:run-preflight', () => {
    // Opportunistically refresh PATH from the Windows registry on
    // every preflight so any external change the user made (manually
    // installing ffmpeg from the ffmpeg.org zip, running `scoop
    // install` from a terminal, etc.) is picked up by the next
    // "重新檢查" click without needing an app restart.  No-op on
    // macOS / Linux.
    refreshSystemPathFromRegistry();
    return runPreflight(getPreflightContext());
  });
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
  ipcMain.handle('queue:add-files', (_event, filePaths) => queueManager.addFiles(filePaths));

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
      sendLog(`[WhisperFlow] ${t('events:log.scanningQueue', { path: effectiveRootPath })}\n`);
      const snapshot = queueManager.scanMedia(effectiveRootPath);
      const { stats, currentJob, scanSummary } = snapshot;

      if (stats.total > 0 && currentJob) {
        sendLog(`[WhisperFlow] ${t('events:log.foundMissingFiles', { count: stats.total })}\n`);
        sendLog(`[WhisperFlow] ${t('events:log.nextQueuedFile', { fileName: currentJob.fileName })}\n`);
      } else {
        sendLog(`[WhisperFlow] ${t('events:log.noMissingFiles')}\n`);
      }

      sendLog(`[WhisperFlow] ${t('events:log.scanComplete', {
        dirs: scanSummary.scannedDirectories,
        files: scanSummary.scannedFiles,
      })}\n`);
      sendDone(0);
    } catch (error) {
      sendRunError(error, {
        code: ERROR_CODES.SCAN_FAILED,
        titleKey: 'errors:SCAN_FAILED.title',
        messageKey: 'errors:SCAN_FAILED.message',
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
          titleKey: 'errors:PREFLIGHT_BLOCKED.title',
          messageKey: 'errors:PREFLIGHT_BLOCKED.message',
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
        titleKey: 'errors:VENV_NOT_INITIALIZED.title',
        messageKey: 'errors:VENV_NOT_INITIALIZED.message',
        suggestedAction: 'initialize-venv',
        source: 'run',
      }));
      sendDone(1);
      return;
    }

    // Model-exists gate — MUST run before startNextJob() so every
    // code path is covered (button click, auto-loop, queue retry,
    // skip-and-continue).  If the configured model isn't fully
    // downloaded, block the run and tell the renderer to show the
    // "go to Models tab" dialog.  This is the main-process
    // counterpart of the renderer-side guard; it's authoritative
    // because it reads config.json + the actual models directory
    // directly, not the DOM form or an IPC result that might fail.
    try {
      const config = readConfig(path.join(pythonDir, 'config', 'config.json'));
      const modelName = config?.SETTING?.model?.trim();
      if (modelName) {
        const { ModelManager } = (() => {
          // Lightweight check: walk the managed models directory
          // for the required files — doesn't import Python, just
          // reads the filesystem.
          const modelsDir = config?.SETTING?.models_dir?.trim();
          const _REQUIRED_METADATA = ['config.json', 'tokenizer.json', 'vocabulary.txt'];
          const _WEIGHT_CANDIDATES = ['model.bin', 'model.safetensors'];
          const fs = require('fs');

          function isModelDownloaded(name) {
            // Map short name to the on-disk directory name that
            // huggingface_hub / our ModelManager uses.
            const dirName = `models--Systran--faster-whisper-${name}`;
            const base = modelsDir || '';
            if (!base) return false;
            const dir = path.join(base, dirName);
            if (!fs.existsSync(dir)) return false;
            for (const f of _REQUIRED_METADATA) {
              const p = path.join(dir, f);
              if (!fs.existsSync(p)) return false;
              try { if (fs.statSync(p).size === 0) return false; } catch (_) { return false; }
            }
            const hasWeight = _WEIGHT_CANDIDATES.some((w) => {
              const p = path.join(dir, w);
              try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch (_) { return false; }
            });
            return hasWeight;
          }

          return { ModelManager: { isDownloaded: isModelDownloaded } };
        })();

        if (!ModelManager.isDownloaded(modelName)) {
          // Broadcast a dedicated event so the renderer can show
          // the "model not downloaded" dialog — same one the
          // renderer-side guard would have shown, but triggered
          // from the main process so auto-loop paths can't skip it.
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('run:model-missing', { model: modelName });
          }
          sendLog(`[WhisperFlow] ${t('downloads:toast.modelNotDownloaded', { model: modelName })}\n`);
          // Do NOT send run:done here — the renderer's run:model-missing
          // handler calls setRunning(false) + syncActionState() itself,
          // and auto-loop naturally stops because onRunDone never fires.
          // Sending run:done(-4) caused a race: if a prior scan's
          // run:done(0) was still queued when the user clicked Run, the
          // stale lastAction='scan' could flip to 'cli' before the
          // scan's done-event arrived, making onRunDone think a CLI
          // transcription succeeded → false "轉錄完成" notification.
          return;
        }
      }
    } catch (err) {
      // If we can't even check, log the reason but DO NOT fall
      // through silently — block the run and surface the error.
      sendRunError(createAppError({
        code: 'MODEL_CHECK_FAILED',
        titleKey: 'errors:MODEL_CHECK_FAILED.title',
        messageKey: 'errors:MODEL_CHECK_FAILED.message',
        message: err.message,
        suggestedAction: 'dismiss-error',
        source: 'run',
      }));
      sendDone(1);
      return;
    }

    const job = queueManager.startNextJob();
    if (!job) {
      sendLog(`[WhisperFlow] ${t('events:log.noQueuedFiles')}\n`);
      sendDone(0);
      return;
    }

    let stderrBuffer = '';
    let lastStructuredError = null;
    sendLog(`[WhisperFlow] ${t('events:log.startingTranscription', { fileName: job.fileName })}\n`);

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
          // Emit a completion log so the Console has a clear "closing
          // bracket" for the "Skip requested" line above — otherwise
          // the user is left wondering if the skip actually happened.
          sendLog(`[WhisperFlow] ${t('events:queue.skippedDone')}\n`);
        } else if (code === -2) {
          queueManager.stopCurrentJob();
          sendLog(`[WhisperFlow] ${t('events:queue.stoppedDone')}\n`);
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
              titleKey: 'errors:TRANSCRIPTION_FAILED.title',
              // Python-side message is already localized via messageKey
              // when the structured event carries one.  When it doesn't,
              // `message` holds the raw error text from ffmpeg/torch/etc
              // — we pass it through verbatim so the user sees the real
              // cause, not a generic translated banner.
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
        titleKey: 'errors:RUNNER_PAUSE_FAILED.title',
        messageKey: 'errors:RUNNER_PAUSE_FAILED.message',
        suggestedAction: 'dismiss-error',
        source: 'run',
      }));
      return;
    }

    queueManager.pauseCurrentJob();
    sendLog(`[WhisperFlow] ${t('events:log.processPaused')}\n`);
  });

  ipcMain.on('run:resume', () => {
    const resumed = resumeProcess();
    if (!resumed) {
      sendRunError(createAppError({
        code: ERROR_CODES.RUNNER_RESUME_FAILED,
        titleKey: 'errors:RUNNER_RESUME_FAILED.title',
        messageKey: 'errors:RUNNER_RESUME_FAILED.message',
        suggestedAction: 'dismiss-error',
        source: 'run',
      }));
      return;
    }

    queueManager.resumeCurrentJob();
    sendLog(`[WhisperFlow] ${t('events:log.processResumed')}\n`);
  });

  ipcMain.on('run:skip-current', () => {
    const skipped = stopProcess(-3);
    if (!skipped) {
      sendRunError(createAppError({
        code: ERROR_CODES.RUNNER_SKIP_FAILED,
        titleKey: 'errors:RUNNER_SKIP_FAILED.title',
        messageKey: 'errors:RUNNER_SKIP_FAILED.message',
        suggestedAction: 'dismiss-error',
        source: 'run',
      }));
      return;
    }

    queueManager.markSkippingCurrent();
    sendLog(`[WhisperFlow] ${t('events:queue.skippingWait')}\n`);
  });

  // ── Bundled venv initialisation ──────────────────────────────────────────

  // ── System Dependency Install (ffmpeg et al) ─────────────────────────
  //
  // Detect which package managers are available on this machine and
  // optionally run an install through one of them.  Used by the
  // preflight panel's "安裝 ffmpeg" button.

  ipcMain.handle('pm:detect', () => {
    return detectAvailableManagers();
  });

  ipcMain.handle('pm:cancel-install', () => {
    // Returns { cancelled: true } if we actually killed a running child,
    // { cancelled: false } if there was nothing to cancel.  Never throws.
    const cancelled = cancelActiveInstall();
    if (cancelled) {
      sendLog(`[WhisperFlow] ${t('events:log.installCancelled')}\n`);
    }
    return { cancelled };
  });

  ipcMain.handle('pm:install', async (_event, payload = {}) => {
    const { managerId, packageName } = payload;
    if (!managerId || !packageName) {
      const err = new Error('pm:install requires { managerId, packageName }');
      err.i18nKey = 'errors:PM_INSTALL_BAD_ARGS.message';
      err.code = 'PM_INSTALL_BAD_ARGS';
      throw err;
    }
    sendLog(`[WhisperFlow] ${t('events:log.installing', { package: packageName, manager: managerId })}\n`);
    const busyKey = `pm-install:${packageName}`;
    addBusyReason(busyKey);
    try {
      await installPackage({
        managerId,
        packageName,
        onLog: (text) => sendLog(text),
      });
      // Refresh PATH from the Windows registry (no-op on macOS/Linux).
      // winget / scoop / choco all drop their shim directories into
      // HKCU\Environment\Path when they install a new tool, but the
      // Electron main process's process.env.PATH was captured at
      // launch time and never sees those writes until the app is
      // restarted.  Without this refresh, the dialog's post-install
      // preflight verification walks the stale PATH, doesn't find
      // ffmpeg, and reports a false "package manager said success
      // but tool is still missing" failure — which is exactly what
      // users hit with winget install ffmpeg on Windows.
      const changed = refreshSystemPathFromRegistry();
      if (changed) {
        sendLog(`[WhisperFlow] ${t('events:log.pathRefreshed')}\n`);
      }
      sendLog(`[WhisperFlow] ${t('events:log.installFinished', { package: packageName, manager: managerId })}\n`);
      return { ok: true };
    } catch (error) {
      sendLog(`[WhisperFlow] ${t('events:log.installFailed', { package: packageName, error: error.message })}\n`);
      throw error;
    } finally {
      removeBusyReason(busyKey);
    }
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      const err = new Error('shell:open-external only accepts http(s) URLs');
      err.i18nKey = 'errors:SHELL_OPEN_EXTERNAL_BAD_URL.message';
      err.code = 'SHELL_OPEN_EXTERNAL_BAD_URL';
      throw err;
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  // ── App metadata ─────────────────────────────────────────────────────────
  // Used by the About tab to render `v{version}` in the hero badge.
  // Reads straight from Electron's `app.getVersion()` (which itself
  // comes from package.json), so a release bump propagates without
  // touching any About-specific constants.
  ipcMain.handle('app:get-version', () => app.getVersion());

  // ── Changelog viewer (About → Version history) ─────────────────
  ipcMain.handle('changelog:list', () => listChangelogEntries(ELECTRON_APP_ROOT));
  ipcMain.handle('changelog:read', (_event, version) => readChangelogEntry(ELECTRON_APP_ROOT, version));

  // ── Diagnostics (About → Report an issue) ──────────────────────
  async function buildDiagnosticsPayload(recentLogLines) {
    const { configPath, venvRoot } = getPaths();
    const config = readConfig(configPath);
    const modelsDir = config?.SETTING?.models_dir || null;
    return collectDiagnostics({
      recentLogLines,
      electronAppRoot: ELECTRON_APP_ROOT,
      venvRoot,
      configPath,
      getLocalSettings,
      modelsDir,
    });
  }

  ipcMain.handle('diagnostics:collect', async (_event, payload = {}) => {
    const data = await buildDiagnosticsPayload(payload.recentLogLines || []);
    return {
      data,
      text: formatDiagnosticsAsText(data),
    };
  });

  // Cheap existence check for history rows — avoids rendering a
  // preview button for a row whose transcript was deleted from disk.
  ipcMain.handle('transcript:exists', (_event, payload = {}) => {
    const { mediaPath, outputDir } = payload;
    return hasTranscriptForMedia(mediaPath, outputDir);
  });

  // ── Transcript preview (Main tab → post-run) ───────────────────
  // Returns a structured result (never throws through the IPC bridge) so
  // the renderer can tell "file was deleted" / "parse failed" / "real
  // crash" apart and show a friendly localized message instead of the
  // raw `Error invoking remote method 'transcript:read'` prefix that
  // Electron otherwise splices into thrown errors.
  ipcMain.handle('transcript:read', (_event, payload = {}) => {
    const { mediaPath, outputDir } = payload;
    try {
      const result = readTranscriptForMedia(mediaPath, outputDir);
      return { ok: true, segments: result.segments, source: result.source };
    } catch (error) {
      const code = error && error.code ? String(error.code) : 'READ_FAILED';
      return {
        ok: false,
        errorCode: code,
        message: error?.message || String(error),
      };
    }
  });

  // ── Storage info (Models tab disk usage) ───────────────────────
  ipcMain.handle('storage:info', (_event, payload = {}) => {
    const targetDir = payload?.dir || readConfig(getPaths().configPath)?.SETTING?.models_dir || '';
    const result = {
      dir: targetDir,
      usedBytes: 0,
      fileCount: 0,
      freeBytes: null,
      totalBytes: null,
    };
    if (!targetDir || !fs.existsSync(targetDir)) {
      return result;
    }
    // Used bytes — recursive file stat (models are typically a handful of
    // large files, so this is fast even without caching).
    const stack = [targetDir];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (_) { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          try {
            result.usedBytes += fs.statSync(full).size;
            result.fileCount += 1;
          } catch (_) {}
        }
      }
    }
    // Free / total — Node 18+ has statfsSync; fall back to nulls on older runtimes.
    if (typeof fs.statfsSync === 'function') {
      try {
        const stats = fs.statfsSync(targetDir);
        result.freeBytes = Number(stats.bavail) * Number(stats.bsize);
        result.totalBytes = Number(stats.blocks) * Number(stats.bsize);
      } catch (_) {}
    }
    return result;
  });

  ipcMain.handle('diagnostics:save', async (_event, payload = {}) => {
    const text = payload.text || '';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save diagnostics',
      defaultPath: `whisperflow-diagnostics-${app.getVersion()}-${stamp}.txt`,
      filters: [{ name: 'Text Files', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, text, 'utf-8');
    return result.filePath;
  });

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
      const err = new Error('No system Python 3 interpreter found. Please install Python 3.10+ or set one in Settings.');
      err.i18nKey = 'errors:BUNDLED_PYTHON_NOT_FOUND.message';
      err.code = 'BUNDLED_PYTHON_NOT_FOUND';
      throw err;
    }

    // Make sure models_dir is in config.json BEFORE the venv finishes — that
    // way, when the renderer re-reads config after the install completes,
    // the Models tab and Settings tab both see the auto-populated path.
    ensureModelsDirInConfig();

    addBusyReason('venv-init');
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
        titleKey: 'errors:VENV_INIT_FAILED.title',
        // Keep the raw exception message as fallback; it's typically the
        // python subprocess's own stderr and often contains actionable
        // detail (e.g. "pip can't reach pypi.org").
        message: error.message || 'Failed to initialize the bundled Python virtual environment.',
        details: error.stack || '',
        source: 'venv',
      }));
      throw error;
    } finally {
      removeBusyReason('venv-init');
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

  ipcMain.handle('models:scan-hf-cache', async () => {
    ensureModelsDirInConfig();
    const stdout = await runVenvPython(['-m', 'whisperflow.cli', '--scan-hf-cache']);
    return JSON.parse(stdout);
  });

  // Legacy shim — kept so old renderer code (and any external
  // scripting that calls `models:download`) keeps working.  The new
  // download pipeline goes through `downloads:start` which streams
  // events instead of blocking on a single JSON result.
  ipcMain.handle('models:download', async (_event, name) => {
    ensureModelsDirInConfig();
    const busyKey = `model-download:${name}`;
    addBusyReason(busyKey);
    try {
      const stdout = await runVenvPython(['-m', 'whisperflow.cli', '--download-model', name]);
      return JSON.parse(stdout);
    } finally {
      removeBusyReason(busyKey);
    }
  });

  // ── Downloads (new streaming pipeline) ────────────────────────────
  //
  // These replace the blocking `models:download` IPC above with a
  // proper state-machine-based flow that streams events to the renderer
  // and persists state to `download-state.json`.

  const downloadState = require('./download-state');
  const downloadRunner = require('./model-download-runner');
  const { get_model: getModelEntry } = (() => {
    // We can't import the Python registry from JS, so we look up the
    // model entry via the same `models:list` IPC we already have.  The
    // start handler calls it once at the beginning to grab repo_id +
    // totalBytes.  This closure caches the last list response.
    let _cachedModels = null;
    return {
      get_model: async (name) => {
        if (!_cachedModels) {
          try {
            ensureModelsDirInConfig();
            const stdout = await runVenvPython(['-m', 'whisperflow.cli', '--list-models']);
            _cachedModels = JSON.parse(stdout);
          } catch (_) {
            return null;
          }
        }
        const entry = (_cachedModels?.models || []).find((m) => m.name === name);
        return entry || null;
      },
    };
  })();

  async function startModelDownload(name) {
    if (downloadRunner.isDownloading()) {
      const err = new Error('Another download is already running');
      err.code = 'DOWNLOAD_ALREADY_RUNNING';
      throw err;
    }

    ensureModelsDirInConfig();

    const { pythonDir, venvRoot } = getPaths();
    const venvPython = resolveBundledPython(venvRoot);
    if (!venvPython) {
      throw new Error('Bundled Python venv is not initialised.');
    }

    const entry = await getModelEntry(name);
    const repoId = entry?.repo_id || `Systran/faster-whisper-${name}`;
    const totalBytes = (entry?.approx_size_mb || 0) * 1024 * 1024;

    let modelsDir = '';
    try {
      const config = readConfig(path.join(pythonDir, 'config', 'config.json'));
      modelsDir = config?.SETTING?.models_dir || '';
    } catch (_) { /* fall through to Python default */ }

    const id = downloadState.addDownload({ name, repoId, totalBytes });

    try {
      downloadRunner.startDownload({ id, name, venvPython, pythonDir, modelsDir });
    } catch (err) {
      downloadState.updateDownload(id, {
        status: 'failed',
        errorCode: 'SPAWN_FAILED',
        errorMessage: err.message,
        finishedAt: new Date().toISOString(),
      });
    }

    return { id, name };
  }

  ipcMain.handle('downloads:start', (_event, name) => startModelDownload(name));

  ipcMain.handle('downloads:cancel', (_event, id) => {
    return { cancelled: downloadRunner.cancelDownload(id) };
  });

  ipcMain.handle('downloads:retry', async (_event, id) => {
    const old = downloadState.getDownload(id);
    if (!old) throw new Error(`Unknown download: ${id}`);
    downloadState.removeDownload(id);
    return startModelDownload(old.name);
  });

  ipcMain.handle('downloads:clear-history', () => {
    downloadState.clearHistory();
    return { ok: true };
  });

  ipcMain.handle('downloads:get-state', () => {
    return downloadState.getAll();
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
        titleKey: 'errors:RUNNER_STOP_FAILED.title',
        messageKey: 'errors:RUNNER_STOP_FAILED.message',
        suggestedAction: 'dismiss-error',
        source: 'run',
      }));
      return;
    }

    queueManager.markStoppingCurrent();
    sendLog(`[WhisperFlow] ${t('events:queue.stoppingWait')}\n`);
  });
}

module.exports = { registerHandlers };
