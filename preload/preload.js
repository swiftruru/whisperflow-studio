'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Config ───────────────────────────────────────────────────────────────
  readConfig:    ()              => ipcRenderer.invoke('config:read'),
  writeConfig:   (data)         => ipcRenderer.invoke('config:write', data),
  listProfiles:  ()             => ipcRenderer.invoke('config:profiles:list'),
  loadProfile:   (configPath)   => ipcRenderer.invoke('config:profiles:load', configPath),

  // ── App Settings ─────────────────────────────────────────────────────────
  readAppSettings:  ()          => ipcRenderer.invoke('appsettings:read'),
  writeAppSettings: (data)      => ipcRenderer.invoke('appsettings:write', data),

  // ── File System Dialogs ───────────────────────────────────────────────────
  browseFolder:    ()           => ipcRenderer.invoke('fs:browse-folder'),
  browseFile:      ()           => ipcRenderer.invoke('fs:browse-file'),
  saveLog:         (text)       => ipcRenderer.invoke('fs:save-log', text),
  // Electron 32+: replaces file.path which is deprecated in contextIsolation mode
  getPathForFile:  (file)       => webUtils.getPathForFile(file),

  // ── Process Control ───────────────────────────────────────────────────────
  setRunning:    (val)          => ipcRenderer.send('app:set-running', val),
  notify:        (opts)         => ipcRenderer.send('app:notify', opts),
  runScan:       (rootPath)     => ipcRenderer.send('run:scan', rootPath),
  runCli:        ()             => ipcRenderer.send('run:cli'),
  runWebUI:      ()             => ipcRenderer.send('run:webui'),
  stopProcess:   ()             => ipcRenderer.send('run:stop'),

  // ── Streaming Log Events (renderer listens) ───────────────────────────────
  onLogData:     (cb)           => ipcRenderer.on('log:data',  (_e, v) => cb(v)),
  onRunDone:     (cb)           => ipcRenderer.on('run:done',  (_e, v) => cb(v)),
  onRunError:    (cb)           => ipcRenderer.on('run:error', (_e, v) => cb(v)),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
