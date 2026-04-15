'use strict';

import { showToast } from './toast.js';
import { refreshPreflight } from './preflight-panel.js';

const overlay = document.getElementById('install-ffmpeg-dialog');
const listEl = document.getElementById('install-ffmpeg-list');
const logEl = document.getElementById('install-ffmpeg-log');
const closeBtn = document.getElementById('btn-install-ffmpeg-close');

let initialized = false;
let installing = false;
let currentPackage = 'ffmpeg';

function appendLog(text) {
  if (!logEl || !text) return;
  logEl.hidden = false;
  logEl.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

function buildAdminCommand(managerId, packageName) {
  const map = {
    choco: `choco install ${packageName} -y`,
    apt: `sudo apt install -y ${packageName}`,
    dnf: `sudo dnf install -y ${packageName}`,
    pacman: `sudo pacman -S --noconfirm ${packageName}`,
  };
  return map[managerId] || `${managerId} install ${packageName}`;
}

function renderManagerRow(manager) {
  const row = document.createElement('div');
  row.className = 'install-ffmpeg-row';
  row.dataset.managerId = manager.id;

  const info = document.createElement('div');
  info.className = 'install-ffmpeg-row-info';

  const title = document.createElement('div');
  title.className = 'install-ffmpeg-row-title';
  title.textContent = manager.label;
  info.appendChild(title);

  const status = document.createElement('div');
  status.className = 'install-ffmpeg-row-status';
  if (!manager.available) {
    status.textContent = '尚未安裝';
  } else if (manager.needsAdmin) {
    status.textContent = '需要管理員權限 — 請在自己的終端機執行';
  } else {
    status.textContent = '可用，可一鍵安裝';
  }
  info.appendChild(status);
  row.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'install-ffmpeg-row-actions';

  if (!manager.available) {
    const docsBtn = document.createElement('button');
    docsBtn.type = 'button';
    docsBtn.className = 'btn-secondary';
    docsBtn.textContent = '前往安裝指南';
    docsBtn.addEventListener('click', () => {
      window.electronAPI.openExternal(manager.installDocsUrl).catch((err) => {
        showToast(`無法開啟網址：${err?.message || err}`, 'error');
      });
    });
    actions.appendChild(docsBtn);
  } else if (manager.needsAdmin) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-secondary';
    copyBtn.textContent = '複製指令';
    copyBtn.addEventListener('click', async () => {
      const cmd = buildAdminCommand(manager.id, currentPackage);
      try {
        await navigator.clipboard.writeText(cmd);
        showToast(`已複製：${cmd}`, 'success', 2400);
      } catch (_) {
        showToast('無法複製指令', 'error');
      }
    });
    actions.appendChild(copyBtn);
  } else {
    const installBtn = document.createElement('button');
    installBtn.type = 'button';
    installBtn.className = 'btn-primary';
    installBtn.textContent = `用 ${manager.label} 安裝`;
    installBtn.addEventListener('click', () => runInstall(manager, installBtn));
    actions.appendChild(installBtn);
  }

  row.appendChild(actions);
  return row;
}

async function runInstall(manager, triggerBtn) {
  if (installing) return;
  installing = true;

  const allButtons = listEl.querySelectorAll('button');
  allButtons.forEach((btn) => { btn.disabled = true; });
  const originalLabel = triggerBtn.textContent;
  triggerBtn.textContent = '安裝中…';

  logEl.hidden = false;
  logEl.textContent = `[${manager.label}] 開始安裝 ${currentPackage}…\n`;

  try {
    await window.electronAPI.installPackage(manager.id, currentPackage);
    appendLog(`\n[${manager.label}] 安裝完成。\n`);
    showToast(`${currentPackage} 安裝完成`, 'success', 3000);
    triggerBtn.textContent = '已安裝';
    await refreshPreflight();
  } catch (error) {
    appendLog(`\n[${manager.label}] 安裝失敗：${error?.message || error}\n`);
    showToast(`安裝失敗：${error?.message || error}`, 'error', 5000);
    triggerBtn.textContent = originalLabel;
    allButtons.forEach((btn) => { btn.disabled = false; });
  } finally {
    installing = false;
  }
}

async function openInstallFfmpegDialog(packageName = 'ffmpeg') {
  if (!overlay) return;
  currentPackage = packageName;

  listEl.innerHTML = '';
  logEl.hidden = true;
  logEl.textContent = '';
  overlay.hidden = false;

  const loading = document.createElement('div');
  loading.className = 'install-ffmpeg-row-status';
  loading.textContent = '偵測可用的套件管理器…';
  listEl.appendChild(loading);

  try {
    const managers = await window.electronAPI.detectPackageManagers();
    listEl.innerHTML = '';

    if (!Array.isArray(managers) || managers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'install-ffmpeg-row-status';
      empty.textContent = '找不到這個平台支援的套件管理器。';
      listEl.appendChild(empty);
      return;
    }

    const sorted = [...managers].sort((a, b) => {
      const score = (m) => (m.available && !m.needsAdmin ? 0 : m.available ? 1 : 2);
      return score(a) - score(b);
    });
    for (const manager of sorted) {
      listEl.appendChild(renderManagerRow(manager));
    }
  } catch (error) {
    listEl.innerHTML = '';
    const fail = document.createElement('div');
    fail.className = 'install-ffmpeg-row-status';
    fail.textContent = `偵測失敗：${error?.message || error}`;
    listEl.appendChild(fail);
  }
}

function closeInstallFfmpegDialog() {
  if (!overlay || installing) return;
  overlay.hidden = true;
}

function initInstallFfmpegDialog() {
  if (initialized) return;
  initialized = true;

  closeBtn?.addEventListener('click', closeInstallFfmpegDialog);
  overlay?.addEventListener('click', (event) => {
    if (event.target === overlay) closeInstallFfmpegDialog();
  });

  window.electronAPI.onLogData?.((text) => {
    if (!overlay || overlay.hidden || !installing) return;
    appendLog(typeof text === 'string' ? text : String(text));
  });
}

export {
  initInstallFfmpegDialog,
  openInstallFfmpegDialog,
};
