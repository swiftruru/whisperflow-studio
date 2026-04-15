'use strict';

// Model Manager tab — lists built-in faster-whisper models, shows which are
// already downloaded into the app-managed models directory, and lets the
// user trigger download / delete operations via the venv'd whisperflow CLI.

import { showToast } from './toast.js';
import { invalidateDynamicModelNames } from './settings-panel.js';
import { confirmDialog } from '../lib/confirm-dialog.js';
import { initializeVenvWithProgress, VENV_INITIALIZED_EVENT } from '../lib/venv-bootstrap.js';

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
  };
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
    installedBadge.textContent = '已安裝';
    topLine.appendChild(installedBadge);
  }

  const repoLine = document.createElement('div');
  repoLine.className = 'model-row-repo';
  repoLine.textContent = entry.repo_id;

  const descLine = document.createElement('div');
  descLine.className = 'model-row-description';
  descLine.textContent = entry.description || '';

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
    deleteBtn.className = 'btn-secondary model-row-btn';
    deleteBtn.textContent = '刪除';
    deleteBtn.addEventListener('click', () => handleDelete(entry.name));
    actions.appendChild(deleteBtn);
  } else {
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'btn-primary model-row-btn';
    downloadBtn.textContent = '下載';
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
    els.dirLabel.textContent = cachedState.modelsDir || '（尚未設定）';
    els.dirLabel.title = cachedState.modelsDir || '';
  }

  if (!els.list) return;
  els.list.innerHTML = '';
  // Reset any CTA state from a previous render.
  els.emptyMsg.classList.remove('models-needs-venv');
  els.emptyMsg.innerHTML = '';

  if (cachedState.loading) {
    els.emptyMsg.hidden = false;
    els.emptyMsg.textContent = '正在載入模型清單…';
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
    els.emptyMsg.textContent = `載入失敗：${cachedState.error}`;
    return;
  }

  if (!cachedState.models.length) {
    els.emptyMsg.hidden = false;
    els.emptyMsg.textContent = '找不到任何可用模型。';
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
  title.textContent = 'Python 虛擬環境尚未建立';

  const desc = document.createElement('div');
  desc.className = 'models-cta-desc';
  desc.textContent = '需要先建立 python/.venv/ 並安裝依賴（faster-whisper、torch 等，約數百 MB）才能列出或下載模型。';

  const btn = document.createElement('button');
  btn.className = 'btn-primary models-cta-btn';
  btn.textContent = '立即建立環境';

  const stageLine = document.createElement('div');
  stageLine.className = 'models-cta-stage';
  stageLine.hidden = true;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '建立中…';
    stageLine.hidden = false;
    stageLine.textContent = '正在啟動 Python 子程序…';
    showToast('正在建立 Python 虛擬環境並安裝依賴（可能需要數分鐘）…', 'info', 5000);
    try {
      await initializeVenvWithProgress({
        onStage: (stage) => {
          stageLine.textContent = `目前階段：${stage}`;
        },
      });
      stageLine.textContent = '環境建立完成';
      showToast('Python 環境建立完成', 'success', 3000);
      await refreshModelManager();
    } catch (error) {
      btn.disabled = false;
      btn.textContent = '立即建立環境';
      stageLine.hidden = true;
      showToast(`環境建立失敗：${error?.message || error}`, 'error', 6000);
    }
  });

  container.appendChild(title);
  container.appendChild(desc);
  container.appendChild(btn);
  container.appendChild(stageLine);
}

async function handleDownload(name) {
  const row = document.querySelector(`.model-row[data-name="${name}"]`);
  const btn = row?.querySelector('.model-row-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '下載中…';
  }
  showToast(`開始下載 ${name}（可能需要數分鐘，取決於網路速度）`, 'info', 4000);
  try {
    await window.electronAPI.downloadModel(name);
    showToast(`${name} 下載完成`, 'success', 3500);
    invalidateDynamicModelNames();
    await fetchModels();
    render();
  } catch (error) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '下載';
    }
    showToast(`下載失敗：${error?.message || error}`, 'error', 6000);
  }
}

async function handleDelete(name) {
  const confirmed = await confirmDialog({
    title: '刪除模型',
    message: `確定要刪除模型 "${name}" 嗎？已下載的權重會從磁碟上移除，下次使用時需要重新下載或從系統 HuggingFace 快取匯入。`,
    confirmText: '刪除',
    cancelText: '取消',
    destructive: true,
  });
  if (!confirmed) return;

  try {
    await window.electronAPI.deleteModel(name);
    showToast(`${name} 已刪除`, 'success', 2500);
    invalidateDynamicModelNames();
    await fetchModels();
    render();
  } catch (error) {
    showToast(`刪除失敗：${error?.message || error}`, 'error', 5000);
  }
}

async function refreshModelManager() {
  await fetchModels();
  render();
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

  // If the user kicked off venv bootstrap from another tab, our cached
  // "needsVenv" state is now stale — refetch and replace the CTA with the
  // real model list.
  window.addEventListener(VENV_INITIALIZED_EVENT, () => {
    refreshModelManager();
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
}

export {
  getModelsState,
  initModelManager,
  refreshModelManager,
  subscribeModels,
};
