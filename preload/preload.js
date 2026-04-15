'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Environment ──────────────────────────────────────────────────────────
  platform: process.platform,

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

  // ── Config ───────────────────────────────────────────────────────────────
  readConfig:    ()              => ipcRenderer.invoke('config:read'),
  readConfigMetadata: ()         => ipcRenderer.invoke('config:metadata:read'),
  writeConfig:   (data)         => ipcRenderer.invoke('config:write', data),
  listProfiles:  ()             => ipcRenderer.invoke('config:profiles:list'),
  loadProfile:   (configPath)   => ipcRenderer.invoke('config:profiles:load', configPath),

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

  // ── File System Dialogs ───────────────────────────────────────────────────
  browseFolder:    ()           => ipcRenderer.invoke('fs:browse-folder'),
  browseFile:      ()           => ipcRenderer.invoke('fs:browse-file'),
  browseAnyFile:   ()           => ipcRenderer.invoke('fs:browse-any-file'),
  saveLog:         (text)       => ipcRenderer.invoke('fs:save-log', text),
  showInFolder:    (filePath)   => ipcRenderer.invoke('shell:show-in-folder', filePath),
  // Electron 32+: replaces file.path which is deprecated in contextIsolation mode
  getPathForFile:  (file)       => webUtils.getPathForFile(file),

  // ── History ───────────────────────────────────────────────────────────────
  readHistory:     ()             => ipcRenderer.invoke('history:read'),
  writeHistory:    (entries)      => ipcRenderer.invoke('history:write', entries),

  // ── Package Managers (for ffmpeg install button) ────────────────────────
  detectPackageManagers: ()                       => ipcRenderer.invoke('pm:detect'),
  installPackage:        (managerId, packageName) => ipcRenderer.invoke('pm:install', { managerId, packageName }),
  openExternal:          (url)                    => ipcRenderer.invoke('shell:open-external', url),

  // ── Bundled Python venv ──────────────────────────────────────────────────
  getVenvStatus:    ()            => ipcRenderer.invoke('venv:status'),
  initializeVenv:   ()            => ipcRenderer.invoke('venv:initialize'),

  // ── Model Manager ────────────────────────────────────────────────────────
  listModels:       ()            => ipcRenderer.invoke('models:list'),
  downloadModel:    (name)        => ipcRenderer.invoke('models:download', name),
  deleteModel:      (name)        => ipcRenderer.invoke('models:delete', name),

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
  onRunnerEvent: (cb)           => ipcRenderer.on('runner:event', (_e, v) => cb(v)),
  onQueueStateUpdated: (cb)     => ipcRenderer.on('queue:state-updated', (_e, v) => cb(v)),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
