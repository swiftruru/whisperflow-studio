'use strict';

import { showToast } from './toast.js';
import { refreshPreflight } from './preflight-panel.js';
import { t } from '../lib/i18n.js';

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
    status.textContent = t('dialogs:installFfmpeg.statusNotInstalled');
  } else if (manager.needsAdmin) {
    status.textContent = t('dialogs:installFfmpeg.statusNeedsAdmin');
  } else {
    status.textContent = t('dialogs:installFfmpeg.statusAvailable');
  }
  info.appendChild(status);

  // Scoop runs a full `scoop update` across every installed bucket
  // before `install`, which on a user with many apps can take several
  // minutes before ffmpeg itself starts downloading.  Warn up front
  // so users don't think the install is hung — other package
  // managers don't have this behaviour and don't need the note.
  if (manager.id === 'scoop' && manager.available) {
    const hint = document.createElement('div');
    hint.className = 'install-ffmpeg-row-hint';
    hint.textContent = t('dialogs:installFfmpeg.scoopUpdateWarning');
    info.appendChild(hint);
  }

  row.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'install-ffmpeg-row-actions';

  if (!manager.available) {
    const docsBtn = document.createElement('button');
    docsBtn.type = 'button';
    docsBtn.className = 'btn-secondary';
    docsBtn.textContent = t('dialogs:installFfmpeg.openDocsButton');
    docsBtn.addEventListener('click', () => {
      window.electronAPI.openExternal(manager.installDocsUrl).catch((err) => {
        showToast(t('dialogs:installFfmpeg.openDocsFailed', { error: err?.message || err }), 'error');
      });
    });
    actions.appendChild(docsBtn);
  } else if (manager.needsAdmin) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-secondary';
    copyBtn.textContent = t('dialogs:installFfmpeg.copyCommand');
    copyBtn.addEventListener('click', async () => {
      const cmd = buildAdminCommand(manager.id, currentPackage);
      try {
        await navigator.clipboard.writeText(cmd);
        showToast(t('dialogs:installFfmpeg.commandCopied', { command: cmd }), 'success', 2400);
      } catch (_) {
        showToast(t('dialogs:installFfmpeg.copyCommandFailed'), 'error');
      }
    });
    actions.appendChild(copyBtn);
  } else {
    const installBtn = document.createElement('button');
    installBtn.type = 'button';
    installBtn.className = 'btn-primary';
    installBtn.textContent = t('dialogs:installFfmpeg.installWith', { manager: manager.label });
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
  triggerBtn.textContent = t('dialogs:installFfmpeg.installing');

  logEl.hidden = false;
  logEl.textContent = t('dialogs:installFfmpeg.installStart', {
    manager: manager.label,
    package: currentPackage,
  }) + '\n';

  try {
    await window.electronAPI.installPackage(manager.id, currentPackage);
    appendLog('\n');
    showToast(t('dialogs:installFfmpeg.installSuccess', { package: currentPackage }), 'success', 3000);
    triggerBtn.textContent = t('dialogs:installFfmpeg.installed');
    await refreshPreflight();
  } catch (error) {
    appendLog('\n' + t('dialogs:installFfmpeg.installFailed', {
      manager: manager.label,
      error: error?.message || error,
    }) + '\n');
    showToast(t('dialogs:installFfmpeg.installFailed', {
      manager: manager.label,
      error: error?.message || error,
    }), 'error', 5000);
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
  loading.textContent = t('dialogs:installFfmpeg.detecting');
  listEl.appendChild(loading);

  try {
    const managers = await window.electronAPI.detectPackageManagers();
    listEl.innerHTML = '';

    if (!Array.isArray(managers) || managers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'install-ffmpeg-row-status';
      empty.textContent = t('dialogs:installFfmpeg.noManagers');
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
    fail.textContent = t('dialogs:installFfmpeg.detectFailed', { error: error?.message || error });
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
