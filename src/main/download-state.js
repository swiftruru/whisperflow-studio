'use strict';

/**
 * Single source of truth for model-download state in the main process.
 *
 * Responsibilities:
 *   - Store the list of current + historical downloads as a `Map<id, Download>`
 *   - Broadcast `downloads:state-updated` to every open BrowserWindow
 *     whenever state changes (debounced on high-frequency progress ticks)
 *   - Persist to `userData/download-state.json` (debounced + before-quit flush)
 *   - Hydrate from disk on boot (mark any `running` entries as `interrupted`)
 *   - Integrate with `busyReasons` close-guard (add/remove reason on start/end)
 *
 * Consumers: ipc-handlers.js (reads + mutates), model-download-runner.js
 * (mutates via `updateDownload`), renderer (reads via IPC).
 */

const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

const SCHEMA_VERSION = 1;

// Debounce periods (ms)
const PERSIST_DEBOUNCE_MS = 250;
const BROADCAST_DEBOUNCE_MS = 80;

let _statePath = null;
let _downloads = new Map();  // id -> download object
let _busyTracker = null;     // { addBusyReason, removeBusyReason }
let _persistTimer = null;
let _broadcastTimer = null;

function _generateId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `dl_${ts}_${rand}`;
}

function _normalizeDownload(raw) {
  return {
    id: raw.id || _generateId(),
    name: raw.name || '',
    status: raw.status || 'pending',
    repoId: raw.repoId || '',
    downloadedBytes: raw.downloadedBytes || 0,
    totalBytes: raw.totalBytes || 0,
    speedBytesPerSec: raw.speedBytesPerSec || 0,
    etaSeconds: raw.etaSeconds || 0,
    stage: raw.stage || '',
    startedAt: raw.startedAt || null,
    finishedAt: raw.finishedAt || null,
    errorCode: raw.errorCode || null,
    errorMessage: raw.errorMessage || null,
  };
}

function _getSnapshot() {
  return {
    schemaVersion: SCHEMA_VERSION,
    downloads: Array.from(_downloads.values()),
  };
}

// ── Broadcast to renderer ─────────────────────────────────────────────

function _broadcastNow() {
  const payload = _getSnapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('downloads:state-updated', payload);
    }
  }
}

function _scheduleBroadcast() {
  if (_broadcastTimer) return;
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null;
    _broadcastNow();
  }, BROADCAST_DEBOUNCE_MS);
}

// ── Persistence ───────────────────────────────────────────────────────

function _persistNow() {
  if (!_statePath) return;
  try {
    fs.writeFileSync(_statePath, JSON.stringify(_getSnapshot(), null, 2), 'utf-8');
  } catch (err) {
    console.error('[download-state] persist failed:', err.message);
  }
}

function _schedulePersist() {
  if (!_statePath) return;
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    _persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

// ── Busy-reason integration ──────────────────────────────────────────

function _syncBusyReason(dl) {
  if (!_busyTracker) return;
  const key = `model-download:${dl.name}`;
  if (dl.status === 'running') {
    _busyTracker.addBusyReason(key);
  } else {
    _busyTracker.removeBusyReason(key);
  }
}

// ── Public API ────────────────────────────────────────────────────────

function configure({ statePath, busyTracker }) {
  _statePath = statePath || null;
  _busyTracker = busyTracker || null;
}

function hydrate() {
  if (!_statePath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(_statePath, 'utf-8'));
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      _downloads = new Map();
      return;
    }
    for (const entry of (raw.downloads || [])) {
      const dl = _normalizeDownload(entry);
      if (dl.status === 'running') {
        dl.status = 'interrupted';
        dl.errorCode = 'APP_RESTART';
        dl.errorMessage = 'Download was interrupted by an app restart.';
        dl.finishedAt = new Date().toISOString();
      }
      _downloads.set(dl.id, dl);
    }
  } catch (_) {
    _downloads = new Map();
  }
}

function shutdown() {
  clearTimeout(_persistTimer);
  clearTimeout(_broadcastTimer);
  _persistNow();
}

function addDownload({ name, repoId, totalBytes }) {
  const id = _generateId();
  const dl = _normalizeDownload({
    id,
    name,
    repoId,
    totalBytes,
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  _downloads.set(id, dl);
  _syncBusyReason(dl);
  _scheduleBroadcast();
  _schedulePersist();
  return id;
}

function updateDownload(id, patch) {
  const existing = _downloads.get(id);
  if (!existing) return;
  if (typeof patch === 'function') {
    const result = patch(existing);
    if (result && result !== existing) {
      Object.assign(existing, result);
    }
  } else {
    Object.assign(existing, patch);
  }
  _syncBusyReason(existing);
  _scheduleBroadcast();
  _schedulePersist();
}

function removeDownload(id) {
  const dl = _downloads.get(id);
  if (!dl) return;
  _downloads.delete(id);
  _syncBusyReason({ ...dl, status: 'removed' });
  _scheduleBroadcast();
  _schedulePersist();
}

function clearHistory() {
  const toRemove = [];
  for (const [id, dl] of _downloads) {
    if (dl.status !== 'running') toRemove.push(id);
  }
  for (const id of toRemove) _downloads.delete(id);
  _scheduleBroadcast();
  _schedulePersist();
}

function getAll() {
  return _getSnapshot();
}

function getDownload(id) {
  return _downloads.get(id) || null;
}

function getRunningDownload() {
  for (const dl of _downloads.values()) {
    if (dl.status === 'running') return dl;
  }
  return null;
}

module.exports = {
  configure,
  hydrate,
  shutdown,
  addDownload,
  updateDownload,
  removeDownload,
  clearHistory,
  getAll,
  getDownload,
  getRunningDownload,
};
