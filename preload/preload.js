'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Subscribe to an updater:* broadcast channel.  Returns a disposer
 * function the caller can call to unsubscribe.  Centralised so all
 * the `onUpdateXxx` wrappers share the same pattern.
 */
function _onUpdater(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Environment ──────────────────────────────────────────────────────────
  platform: process.platform,
  getAppVersion: ()      => ipcRenderer.invoke('app:get-version'),

  // ── i18n ────────────────────────────────────────────────────────────────
  i18n: {
    getInitial:  ()        => ipcRenderer.invoke('i18n:get-initial'),
    setLanguage: (lang)    => ipcRenderer.invoke('i18n:set-language', lang),
    onLanguageChanged: (cb) => {
      const handler = (_e, lang) => cb(lang);
      ipcRenderer.on('i18n:language-changed', handler);
      return () => ipcRenderer.removeListener('i18n:language-changed', handler);
    },
  },

  // ── Updater ─────────────────────────────────────────────────────────────
  // Exposes the main-process updater module to the renderer.  The
  // three `invoke` channels let renderer components actively trigger
  // behaviour; the `onXxx()` subscribers let renderer components
  // react to broadcasts coming from the main-process orchestrator.
  updater: {
    check:       (opts = {})    => ipcRenderer.invoke('updater:check', opts),
    skip:        (version)      => ipcRenderer.invoke('updater:skip', version),
    start:       ()             => ipcRenderer.invoke('updater:start'),
    install:     ()             => ipcRenderer.invoke('updater:install'),
    getStrategy: ()             => ipcRenderer.invoke('updater:get-strategy'),
    onChecking:          (cb) => _onUpdater('updater:checking', cb),
    onUpdateAvailable:   (cb) => _onUpdater('updater:update-available', cb),
    onUpToDate:          (cb) => _onUpdater('updater:up-to-date', cb),
    onError:             (cb) => _onUpdater('updater:error', cb),
    onDownloadProgress:  (cb) => _onUpdater('updater:download-progress', cb),
    onDownloadDone:      (cb) => _onUpdater('updater:download-done', cb),
    onSkipped:           (cb) => _onUpdater('updater:skipped', cb),
  },

  // ── Menu bridge ──────────────────────────────────────────────────────────
  // Main process emits `menu:open-about` when the user clicks
  // "About WhisperFlow Studio" in the application menu.  Renderer
  // listens and switches to the About tab.
  onMenuOpenAbout: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('menu:open-about', handler);
    return () => ipcRenderer.removeListener('menu:open-about', handler);
  },

  // ── Tray actions ─────────────────────────────────────────────────────────
  // Main process broadcasts `tray:action` with a string ('run' | 'scan' |
  // 'stop') when the user picks an item from the tray menu or triggers a
  // global shortcut.  Renderer proxies that to the controls-bar.
  onTrayAction: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('tray:action', handler);
    return () => ipcRenderer.removeListener('tray:action', handler);
  },

  // ── File-association opens ───────────────────────────────────────────────
  // Main broadcasts `file-association:open` with an array of absolute
  // paths after an OS-level "Open with WhisperFlow Studio" event.
  onFileAssociationOpen: (cb) => {
    const handler = (_e, paths) => cb(paths);
    ipcRenderer.on('file-association:open', handler);
    return () => ipcRenderer.removeListener('file-association:open', handler);
  },

  // ── Config ───────────────────────────────────────────────────────────────
  readConfig:    ()              => ipcRenderer.invoke('config:read'),
  readConfigMetadata: ()         => ipcRenderer.invoke('config:metadata:read'),
  writeConfig:   (data)         => ipcRenderer.invoke('config:write', data),
  listProfiles:  ()             => ipcRenderer.invoke('config:profiles:list'),
  loadProfile:   (configPath)   => ipcRenderer.invoke('config:profiles:load', configPath),
  createProfile: (name, seed)   => ipcRenderer.invoke('config:profiles:create', { name, seed }),
  renameProfile: (oldName, newName) => ipcRenderer.invoke('config:profiles:rename', { oldName, newName }),
  deleteProfile: (name)         => ipcRenderer.invoke('config:profiles:delete', name),

  // ── App Settings ─────────────────────────────────────────────────────────
  readAppSettings:  ()          => ipcRenderer.invoke('appsettings:read'),
  writeAppSettings: (data)      => ipcRenderer.invoke('appsettings:write', data),
  runPreflight:     ()          => ipcRenderer.invoke('app:run-preflight'),
  validateSettingField: (data)  => ipcRenderer.invoke('app:validate-setting-field', data),
  getQueueState:    ()          => ipcRenderer.invoke('queue:get-state'),
  retryFailedQueueJobs: ()      => ipcRenderer.invoke('queue:retry-failed'),
  clearFinishedQueueJobs: ()    => ipcRenderer.invoke('queue:clear-finished'),
  retryQueueJob:    (jobId)     => ipcRenderer.invoke('queue:retry-job', jobId),
  removeQueueJob:   (jobId)     => ipcRenderer.invoke('queue:remove-job', jobId),
  moveQueueJob:     (jobId, direction) => ipcRenderer.invoke('queue:move-job', jobId, direction),
  addQueueFiles:    (filePaths)       => ipcRenderer.invoke('queue:add-files', filePaths),

  // ── File System Dialogs ───────────────────────────────────────────────────
  browseFolder:    ()           => ipcRenderer.invoke('fs:browse-folder'),
  browseFile:      ()           => ipcRenderer.invoke('fs:browse-file'),
  browseAnyFile:   ()           => ipcRenderer.invoke('fs:browse-any-file'),
  saveLog:         (text)       => ipcRenderer.invoke('fs:save-log', text),
  showInFolder:    (filePath)   => ipcRenderer.invoke('shell:show-in-folder', filePath),
  openPath:        (dirPath)    => ipcRenderer.invoke('shell:open-path', dirPath),
  // Electron 32+: replaces file.path which is deprecated in contextIsolation mode
  getPathForFile:  (file)       => webUtils.getPathForFile(file),

  // ── History ───────────────────────────────────────────────────────────────
  readHistory:     ()             => ipcRenderer.invoke('history:read'),
  writeHistory:    (entries)      => ipcRenderer.invoke('history:write', entries),

  // ── Package Managers (for ffmpeg install button) ────────────────────────
  detectPackageManagers: ()                       => ipcRenderer.invoke('pm:detect'),
  installPackage:        (managerId, packageName) => ipcRenderer.invoke('pm:install', { managerId, packageName }),
  cancelInstallPackage:  ()                       => ipcRenderer.invoke('pm:cancel-install'),
  openExternal:          (url)                    => ipcRenderer.invoke('shell:open-external', url),

  // ── Bundled Python venv ──────────────────────────────────────────────────
  getVenvStatus:    ()            => ipcRenderer.invoke('venv:status'),
  initializeVenv:   ()            => ipcRenderer.invoke('venv:initialize'),

  // ── Model Manager ────────────────────────────────────────────────────────
  listModels:       ()            => ipcRenderer.invoke('models:list'),
  downloadModel:    (name)        => ipcRenderer.invoke('models:download', name),
  deleteModel:      (name)        => ipcRenderer.invoke('models:delete', name),
  scanHfCache:      ()            => ipcRenderer.invoke('models:scan-hf-cache'),

  // ── Model Downloads (streaming pipeline) ────────────────────────────────
  downloads: {
    start:          (name)        => ipcRenderer.invoke('downloads:start', name),
    cancel:         (id)          => ipcRenderer.invoke('downloads:cancel', id),
    retry:          (id)          => ipcRenderer.invoke('downloads:retry', id),
    clearHistory:   ()            => ipcRenderer.invoke('downloads:clear-history'),
    getState:       ()            => ipcRenderer.invoke('downloads:get-state'),
    onStateUpdated: (cb)          => ipcRenderer.on('downloads:state-updated', (_e, s) => cb(s)),
  },

  // ── Changelog viewer (About → Version history) ──────────────────────────
  changelog: {
    list: ()        => ipcRenderer.invoke('changelog:list'),
    read: (version) => ipcRenderer.invoke('changelog:read', version),
  },

  // ── Diagnostics (About → Report an issue) ───────────────────────────────
  diagnostics: {
    collect: (opts = {}) => ipcRenderer.invoke('diagnostics:collect', opts),
    save:    (payload)   => ipcRenderer.invoke('diagnostics:save', payload),
  },

  // ── Transcript preview (Main tab → post-run) ────────────────────────────
  transcript: {
    read:   (opts = {}) => ipcRenderer.invoke('transcript:read', opts),
    exists: (opts = {}) => ipcRenderer.invoke('transcript:exists', opts),
  },

  // ── Storage info (Models tab disk usage) ────────────────────────────────
  storage: {
    info: (opts = {}) => ipcRenderer.invoke('storage:info', opts),
  },

  // ── Process Control ───────────────────────────────────────────────────────
  setRunning:    (val)          => ipcRenderer.send('app:set-running', val),
  notify:        (opts)         => ipcRenderer.send('app:notify', opts),
  runScan:       (rootPath)     => ipcRenderer.send('run:scan', rootPath),
  runCli:        ()             => ipcRenderer.send('run:cli'),
  pauseProcess:  ()             => ipcRenderer.send('run:pause'),
  resumeProcess: ()             => ipcRenderer.send('run:resume'),
  skipCurrent:   ()             => ipcRenderer.send('run:skip-current'),
  stopProcess:   ()             => ipcRenderer.send('run:stop'),

  // ── Streaming Log Events (renderer listens) ───────────────────────────────
  onLogData:     (cb)           => ipcRenderer.on('log:data',  (_e, v) => cb(v)),
  // Scoped log listener that returns a disposer — used for transient taps
  // (e.g. venv bootstrap progress parser) that shouldn't nuke the main
  // console-log listener on teardown.
  addLogDataListener: (cb) => {
    const handler = (_e, v) => cb(v);
    ipcRenderer.on('log:data', handler);
    return () => ipcRenderer.removeListener('log:data', handler);
  },
  onRunDone:     (cb)           => ipcRenderer.on('run:done',  (_e, v) => cb(v)),
  onRunError:    (cb)           => ipcRenderer.on('run:error', (_e, v) => cb(v)),
  onModelMissing:(cb)           => ipcRenderer.on('run:model-missing', (_e, v) => cb(v)),
  onRunnerEvent: (cb)           => ipcRenderer.on('runner:event', (_e, v) => cb(v)),
  onQueueStateUpdated: (cb)     => ipcRenderer.on('queue:state-updated', (_e, v) => cb(v)),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
