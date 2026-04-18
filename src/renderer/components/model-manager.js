'use strict';

// Model Manager tab — lists built-in faster-whisper models, shows which are
// already downloaded into the app-managed models directory, and lets the
// user trigger download / delete operations via the venv'd whisperflow CLI.

import { showToast } from './toast.js';
import { invalidateDynamicModelNames } from './settings-panel.js';
import { confirmDialog } from '../lib/confirm-dialog.js';
import { initializeVenvWithProgress, VENV_INITIALIZED_EVENT } from '../lib/venv-bootstrap.js';
import { subscribeDownloads } from './download-state.js';
import { t } from '../lib/i18n.js';

const modelsSubscribers = new Set();
let cachedState = {
  loading: true,
  error: null,
  needsVenv: false,
  modelsDir: '',
  models: [],
};

function notify() {
  for (const listener of modelsSubscribers) {
    try { listener(cachedState); } catch (e) { console.error(e); }
  }
}

function formatSize(mb) {
  if (!mb || mb < 0) return '—';
  if (mb < 1024) return `${mb} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

async function fetchModels() {
  cachedState = { ...cachedState, loading: true, error: null, needsVenv: false };
  notify();

  // Check venv state first so we can show a friendly "install environment"
  // CTA instead of a scary raw IPC error when it's not initialised.
  try {
    const venv = await window.electronAPI.getVenvStatus();
    if (!venv?.initialized) {
      cachedState = {
        loading: false,
        error: null,
        needsVenv: true,
        modelsDir: '',
        models: [],
      };
      notify();
      return cachedState;
    }
  } catch (_) {
    // If even the status check fails, fall through to listModels and
    // surface whatever error it produces.
  }

  try {
    const result = await window.electronAPI.listModels();
    cachedState = {
      loading: false,
      error: null,
      needsVenv: false,
      modelsDir: result?.models_dir || '',
      models: Array.isArray(result?.models) ? result.models : [],
    };
  } catch (error) {
    cachedState = {
      loading: false,
      error: error?.message || String(error),
      needsVenv: false,
      modelsDir: '',
      models: [],
    };
  }
  notify();
  return cachedState;
}

function getPanelElements() {
  return {
    panel:      document.getElementById('tab-models'),
    dirLabel:   document.getElementById('models-dir-label'),
    list:       document.getElementById('models-list'),
    refreshBtn: document.getElementById('btn-models-refresh'),
    emptyMsg:   document.getElementById('models-empty-msg'),
    storageRow: document.getElementById('models-storage'),
    storageUsed: document.getElementById('models-storage-used'),
    storageFree: document.getElementById('models-storage-free'),
  };
}

function formatBytesShort(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

async function refreshStorageRow() {
  const els = getPanelElements();
  if (!els.storageRow) return;
  const dir = cachedState.modelsDir;
  if (!dir) {
    els.storageRow.hidden = true;
    return;
  }
  try {
    const info = await window.electronAPI.storage.info({ dir });
    els.storageRow.hidden = false;
    els.storageUsed.textContent = t('models:storage.used', {
      size: formatBytesShort(info.usedBytes),
      count: info.fileCount,
    });
    if (info.freeBytes !== null && info.freeBytes !== undefined) {
      els.storageFree.textContent = t('models:storage.free', {
        size: formatBytesShort(info.freeBytes),
      });
      els.storageFree.hidden = false;
    } else {
      els.storageFree.hidden = true;
    }
  } catch (_) {
    els.storageRow.hidden = true;
  }
}

function renderRow(entry) {
  const row = document.createElement('div');
  row.className = `model-row${entry.installed ? ' installed' : ''}`;
  row.dataset.name = entry.name;

  // ── left block: identity ────────────────────────────────────────────────
  const info = document.createElement('div');
  info.className = 'model-row-info';

  const topLine = document.createElement('div');
  topLine.className = 'model-row-title';

  const nameBadge = document.createElement('span');
  nameBadge.className = 'model-row-name';
  nameBadge.textContent = entry.name;
  topLine.appendChild(nameBadge);

  if (entry.installed) {
    const installedBadge = document.createElement('span');
    installedBadge.className = 'model-row-badge installed';
    installedBadge.textContent = t('models:actions.installed');
    topLine.appendChild(installedBadge);
  }

  const repoLine = document.createElement('div');
  repoLine.className = 'model-row-repo';
  repoLine.textContent = entry.repo_id;

  const descLine = document.createElement('div');
  descLine.className = 'model-row-description';
  // Prefer the localized registry blurb when the model name matches a
  // known key; fall back to whatever the Python registry sent so custom
  // / future models still render a description even before translations
  // are added.  i18next's `defaultValue` option short-circuits to the
  // fallback when the key is missing, which is how we stay robust
  // across model additions that beat the translation file.
  descLine.textContent = t(`models:registry.${entry.name}.description`, {
    defaultValue: entry.description || '',
  });

  info.appendChild(topLine);
  info.appendChild(repoLine);
  info.appendChild(descLine);

  // ── right block: size + actions ────────────────────────────────────────
  const actions = document.createElement('div');
  actions.className = 'model-row-actions';

  const sizeLabel = document.createElement('div');
  sizeLabel.className = 'model-row-size';
  sizeLabel.textContent = formatSize(entry.approx_size_mb);
  actions.appendChild(sizeLabel);

  if (entry.installed) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-secondary model-row-btn model-row-btn-delete';
    deleteBtn.textContent = t('models:actions.delete');
    deleteBtn.addEventListener('click', () => handleDelete(entry.name));
    actions.appendChild(deleteBtn);
  } else {
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'btn-primary model-row-btn model-row-download';
    downloadBtn.textContent = t('models:actions.download');
    downloadBtn.addEventListener('click', () => handleDownload(entry.name));
    actions.appendChild(downloadBtn);
  }

  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

function render() {
  const els = getPanelElements();
  if (!els.panel) return;

  if (els.dirLabel) {
    els.dirLabel.textContent = cachedState.modelsDir || t('models:toolbar.dirUnset');
    els.dirLabel.title = cachedState.modelsDir || '';
  }

  if (!els.list) return;
  els.list.innerHTML = '';
  // Reset any CTA state from a previous render.
  els.emptyMsg.classList.remove('models-needs-venv');
  els.emptyMsg.innerHTML = '';

  if (cachedState.loading) {
    els.emptyMsg.hidden = false;
    els.emptyMsg.textContent = t('models:list.loading');
    return;
  }

  if (cachedState.needsVenv) {
    els.emptyMsg.hidden = false;
    els.emptyMsg.classList.add('models-needs-venv');
    renderVenvCta(els.emptyMsg);
    return;
  }

  if (cachedState.error) {
    els.emptyMsg.hidden = false;
    els.emptyMsg.textContent = t('models:list.loadFailed', { error: cachedState.error });
    return;
  }

  if (!cachedState.models.length) {
    els.emptyMsg.hidden = false;
    els.emptyMsg.textContent = t('models:list.empty');
    return;
  }

  els.emptyMsg.hidden = true;
  cachedState.models.forEach((entry) => {
    els.list.appendChild(renderRow(entry));
  });
}

function renderVenvCta(container) {
  const title = document.createElement('div');
  title.className = 'models-cta-title';
  title.textContent = t('models:venvRequired.title');

  const desc = document.createElement('div');
  desc.className = 'models-cta-desc';
  desc.textContent = t('models:venvRequired.description');

  const btn = document.createElement('button');
  btn.className = 'btn-primary models-cta-btn';
  btn.textContent = t('models:venvRequired.initializeButton');

  const stageLine = document.createElement('div');
  stageLine.className = 'models-cta-stage';
  stageLine.hidden = true;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = t('models:venvRequired.initializing');
    stageLine.hidden = false;
    stageLine.textContent = t('preflight:venvBootstrap.starting');
    showToast(t('toasts:venv.creating'), 'info', 5000);
    try {
      await initializeVenvWithProgress({
        onStage: (stage) => {
          stageLine.textContent = t('preflight:venvBootstrap.stage', { stage });
        },
      });
      stageLine.textContent = t('preflight:venvBootstrap.completed');
      showToast(t('toasts:venv.success'), 'success', 3000);
      await refreshModelManager();
    } catch (error) {
      btn.disabled = false;
      btn.textContent = t('models:venvRequired.initializeButton');
      stageLine.hidden = true;
      showToast(t('toasts:venv.failed', { error: error?.message || error }), 'error', 6000);
    }
  });

  container.appendChild(title);
  container.appendChild(desc);
  container.appendChild(btn);
  container.appendChild(stageLine);
}

async function handleDownload(name) {
  // Fire-and-forget via the new streaming downloads pipeline.
  // Progress feedback is handled entirely by download-panel.js
  // which subscribes to the download-state store.  We just kick
  // off the download here and let the state machine take over.
  try {
    await window.electronAPI.downloads.start(name);
    showToast(t('downloads:toast.started', { name }), 'info', 3000);
  } catch (error) {
    if (error?.code === 'DOWNLOAD_ALREADY_RUNNING') {
      showToast(t('downloads:toast.alreadyRunning'), 'info', 4000);
      return;
    }
    showToast(t('downloads:toast.failed', { name, error: error?.message || error }), 'error', 6000);
  }
}

async function handleDelete(name) {
  const confirmed = await confirmDialog({
    title: t('models:confirmDelete.title'),
    message: t('models:confirmDelete.message', { name }),
    confirmText: t('models:confirmDelete.confirmText'),
    cancelText: t('models:confirmDelete.cancelText'),
    destructive: true,
  });
  if (!confirmed) return;

  try {
    await window.electronAPI.deleteModel(name);
    showToast(t('models:toast.deleteSuccess', { name }), 'success', 2500);
    invalidateDynamicModelNames();
    await fetchModels();
    render();
    refreshStorageRow();
  } catch (error) {
    showToast(t('models:toast.deleteFailed', { error: error?.message || error }), 'error', 5000);
  }
}

async function refreshModelManager() {
  await fetchModels();
  render();
  refreshStorageRow();
}

function subscribeModels(listener) {
  modelsSubscribers.add(listener);
  listener(cachedState);
  return () => modelsSubscribers.delete(listener);
}

function getModelsState() {
  return cachedState;
}

function initModelManager() {
  const els = getPanelElements();
  if (!els.panel) return;

  els.refreshBtn?.addEventListener('click', () => refreshModelManager());

  const openDirBtn = document.getElementById('btn-models-open-dir');
  if (openDirBtn) {
    openDirBtn.addEventListener('click', () => {
      const dir = cachedState.modelsDir;
      if (!dir) return;
      window.electronAPI.openPath(dir).catch((err) => {
        console.error('[models] openPath failed:', err);
      });
    });
  }

  const scanBtn = document.getElementById('btn-scan-hf-cache');
  if (scanBtn) {
    scanBtn.addEventListener('click', async () => {
      const originalLabel = scanBtn.textContent;
      scanBtn.disabled = true;
      scanBtn.textContent = t('models:hfCache.scanning');
      try {
        const result = await window.electronAPI.scanHfCache();
        const available = Array.isArray(result?.available) ? result.available : [];
        if (available.length === 0) {
          showToast(t('models:hfCache.noneFound'), 'info', 3500);
        } else {
          const names = available.map((m) => m.name).join(', ');
          const confirmed = await confirmDialog({
            title: t('models:hfCache.importTitle'),
            message: t('models:hfCache.importMessage', { count: available.length, names }),
            confirmText: t('models:hfCache.importConfirm'),
          });
          if (confirmed) {
            // Trigger a normal download for each — download() uses the
            // fast-path HF-cache import when the model is available,
            // so this effectively just hard-links the files into place.
            for (const model of available) {
              try { await handleDownload(model.name); } catch (_) {}
            }
          }
        }
      } catch (err) {
        showToast(t('models:hfCache.scanFailed', { error: err?.message || String(err) }), 'error', 4000);
      } finally {
        scanBtn.disabled = false;
        scanBtn.textContent = originalLabel;
      }
    });
  }

  // If the user kicked off venv bootstrap from another tab, our cached
  // "needsVenv" state is now stale — refetch and replace the CTA with the
  // real model list.
  window.addEventListener(VENV_INITIALIZED_EVENT, () => {
    refreshModelManager();
  });

  // Re-render rows in the new language without re-fetching — all the
  // user-facing strings come from i18n keys, not from cachedState, so
  // a plain render() is enough.
  window.addEventListener('app:language-changed', () => {
    render();
  });

  // Refresh whenever the user actually switches to the Models tab; otherwise
  // we don't hit the Python venv at startup and can survive a not-yet-
  // initialized environment.
  const modelsTabBtn = document.querySelector('[data-tab="models"]');
  modelsTabBtn?.addEventListener('click', () => {
    if (
      cachedState.loading
      || cachedState.error
      || cachedState.needsVenv
      || !cachedState.models.length
    ) {
      refreshModelManager();
    }
  });

  // Disable all download buttons while a download is running so the
  // user can't spam-click and trigger "already running" errors.
  let _wasDownloading = false;
  subscribeDownloads((dlState) => {
    const isDownloading = dlState.stats.running > 0;
    if (_wasDownloading && !isDownloading) {
      // A download just finished — the Models directory just grew (or
      // was freed via cancel).  Refresh storage to reflect the change.
      refreshStorageRow();
    }
    _wasDownloading = isDownloading;
    const currentName = dlState.current?.name || '';
    const btns = document.querySelectorAll('.model-row-download');
    for (const btn of btns) {
      const row = btn.closest('.model-row');
      const name = row?.dataset?.name || '';
      if (isDownloading) {
        btn.disabled = true;
        btn.textContent = name === currentName
          ? t('models:actions.downloading')
          : t('models:actions.download');
      } else {
        btn.disabled = false;
        btn.textContent = t('models:actions.download');
      }
    }
  });
}

export {
  getModelsState,
  initModelManager,
  refreshModelManager,
  subscribeModels,
};
