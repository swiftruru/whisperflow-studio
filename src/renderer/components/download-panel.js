'use strict';

/**
 * Persistent download card inside the Models tab.
 *
 * Subscribes to the download-state store and renders the current
 * download's progress bar + bytes + speed + ETA, plus a collapsible
 * history list.  Handles cancel / retry / clear-history actions.
 */

import { subscribeDownloads } from './download-state.js';
import { showToast } from './toast.js';
import { t } from '../lib/i18n.js';
import { refreshModelManager } from './model-manager.js';

const panel = document.getElementById('download-panel');
const currentWrap = document.getElementById('download-current');
const nameEl = document.getElementById('download-current-name');
const stageEl = document.getElementById('download-current-stage');
const progressFill = document.getElementById('download-progress-fill');
const percentEl = document.getElementById('download-current-percent');
const bytesEl = document.getElementById('download-current-bytes');
const speedEl = document.getElementById('download-current-speed');
const etaEl = document.getElementById('download-current-eta');
const cancelBtn = document.getElementById('btn-download-cancel');
const historyDetails = document.getElementById('download-history');
const historyList = document.getElementById('download-history-list');
const clearHistoryBtn = document.getElementById('btn-download-clear-history');

let _prevCurrentId = null;
let _prevCurrentStatus = null;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const val = bytes / Math.pow(k, i);
  return `${val < 10 ? val.toFixed(2) : val < 100 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  return t('downloads:current.speed', { speed: formatBytes(bytesPerSec) });
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m > 0) return `${t('downloads:current.etaPrefix')} ${m}m ${s}s`;
  return `${t('downloads:current.etaPrefix')} ${s}s`;
}

function renderCurrent(dl) {
  if (!dl) {
    currentWrap.hidden = true;
    return;
  }

  currentWrap.hidden = false;
  nameEl.textContent = dl.name;
  stageEl.textContent = dl.stage ? t(`downloads:stage.${dl.stage}`, { defaultValue: dl.stage }) : '';

  const total = dl.totalBytes || 0;
  const downloaded = dl.downloadedBytes || 0;
  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;

  progressFill.style.width = `${percent}%`;
  percentEl.textContent = t('downloads:current.percent', { percent });
  bytesEl.textContent = t('downloads:current.bytes', {
    downloaded: formatBytes(downloaded),
    total: formatBytes(total),
  });
  speedEl.textContent = formatSpeed(dl.speedBytesPerSec);
  etaEl.textContent = dl.etaSeconds > 0
    ? formatEta(dl.etaSeconds)
    : t('downloads:current.etaCalculating');

  cancelBtn.hidden = false;
}

function renderHistory(history) {
  if (!history || history.length === 0) {
    historyDetails.hidden = true;
    return;
  }
  historyDetails.hidden = false;
  historyList.innerHTML = '';
  for (const dl of history) {
    const li = document.createElement('li');
    li.className = 'download-history-item';
    li.dataset.status = dl.status;

    const name = document.createElement('span');
    name.className = 'download-history-name';
    name.textContent = dl.name;
    li.appendChild(name);

    const status = document.createElement('span');
    status.className = 'download-history-status';
    status.textContent = t(`downloads:status.${dl.status}`, { defaultValue: dl.status });
    li.appendChild(status);

    if (dl.errorMessage) {
      const error = document.createElement('span');
      error.className = 'download-history-error';
      error.textContent = dl.errorMessage;
      li.appendChild(error);
    }

    if (dl.status === 'failed' || dl.status === 'cancelled' || dl.status === 'interrupted') {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn-inline-action';
      retryBtn.textContent = t('downloads:actions.retry');
      retryBtn.addEventListener('click', async () => {
        try {
          await window.electronAPI.downloads.retry(dl.id);
        } catch (err) {
          showToast(err?.message || 'Retry failed', 'error', 4000);
        }
      });
      li.appendChild(retryBtn);
    }

    historyList.appendChild(li);
  }
}

function _detectTransitions(state) {
  // Find the download that was previously "current" (running) — it may
  // now be in history (completed/failed/cancelled) or still running.
  const allDownloads = state.downloads || [];
  const tracked = _prevCurrentId
    ? allDownloads.find((d) => d.id === _prevCurrentId)
    : null;
  const newCurrent = state.current;

  // Track the new current if it just appeared.
  if (newCurrent && newCurrent.id !== _prevCurrentId) {
    _prevCurrentId = newCurrent.id;
    _prevCurrentStatus = newCurrent.status;
    return;
  }

  // If the tracked download changed status, fire toasts + refresh.
  if (tracked && tracked.status !== _prevCurrentStatus) {
    const prevSt = _prevCurrentStatus;
    _prevCurrentStatus = tracked.status;

    if (tracked.status === 'completed' && prevSt === 'running') {
      showToast(t('downloads:toast.completed', { name: tracked.name }), 'success', 3500);
      refreshModelManager().catch(() => {});
    } else if (tracked.status === 'failed' && prevSt === 'running') {
      showToast(t('downloads:toast.failed', { name: tracked.name, error: tracked.errorMessage || '' }), 'error', 5000);
    } else if (tracked.status === 'cancelled' && prevSt === 'running') {
      showToast(t('downloads:toast.cancelled', { name: tracked.name }), 'info', 3000);
    }
  }

  // Update tracking for current.
  if (newCurrent) {
    _prevCurrentId = newCurrent.id;
    _prevCurrentStatus = newCurrent.status;
  }
}

function render(state) {
  if (!panel) return;

  // Detect status transitions BEFORE any early return — when a
  // download completes, `current` becomes null (completed items move
  // to `history`), so renderCurrent() would skip the transition check
  // entirely if we put it there.  We track by looking at the latest
  // download entry that was previously the "current" one.
  _detectTransitions(state);

  const hasAnything = state.stats.total > 0;
  panel.hidden = !hasAnything;
  if (!hasAnything) return;

  renderCurrent(state.current);

  // Show history when no download is running but there are completed / failed
  if (!state.current && state.history.length > 0) {
    currentWrap.hidden = true;
    renderHistory(state.history);
  } else if (state.current) {
    renderHistory([]);
  }
}

function initDownloadPanel() {
  if (!panel) return;

  cancelBtn?.addEventListener('click', async () => {
    const state = (await import('./download-state.js')).getDownloadState();
    const dl = state.current;
    if (!dl) return;
    try {
      await window.electronAPI.downloads.cancel(dl.id);
    } catch (err) {
      showToast(err?.message || 'Cancel failed', 'error', 4000);
    }
  });

  clearHistoryBtn?.addEventListener('click', async () => {
    try {
      await window.electronAPI.downloads.clearHistory();
    } catch (_) {}
  });

  subscribeDownloads(render);
}

export { initDownloadPanel };
