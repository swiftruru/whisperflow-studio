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

function setCloseButtonMode(mode) {
  if (!closeBtn) return;
  if (mode === 'cancel') {
    closeBtn.textContent = t('dialogs:installFfmpeg.cancelInstall');
    closeBtn.dataset.mode = 'cancel';
  } else {
    closeBtn.textContent = t('dialogs:installFfmpeg.close');
    closeBtn.dataset.mode = 'close';
  }
}

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

  // Close button becomes "Cancel install" during active install so the
  // user can bail out of a hung Scoop bucket update instead of being
  // locked in the dialog until the process finishes.
  setCloseButtonMode('cancel');

  logEl.hidden = false;
  logEl.textContent = t('dialogs:installFfmpeg.installStart', {
    manager: manager.label,
    package: currentPackage,
  }) + '\n';

  try {
    await window.electronAPI.installPackage(manager.id, currentPackage);
    appendLog('\n');

    // Verify the tool is actually reachable after the package manager
    // reported success.  Scoop in particular can exit 0 on a failed
    // extraction (the `ffmpeg 7z decompress-error` bug users have
    // reported), and winget's `--silent` mode occasionally reports
    // success even when the user cancels a UAC prompt.  If the
    // preflight still flags ffmpeg as missing, treat the install as
    // failed instead of lying to the user with an "Installed" badge.
    const preflightState = await refreshPreflight();
    const stillMissing = currentPackage === 'ffmpeg'
      && preflightState?.checks?.some((c) => c.key === 'ffmpeg' && c.status === 'error');
    if (stillMissing) {
      const syntheticError = new Error(
        t('dialogs:installFfmpeg.verifyFailed', { manager: manager.label, package: currentPackage }),
      );
      syntheticError.code = 'PM_VERIFY_FAILED';
      throw syntheticError;
    }

    showToast(t('dialogs:installFfmpeg.installSuccess', { package: currentPackage }), 'success', 3000);
    triggerBtn.textContent = t('dialogs:installFfmpeg.installed');
  } catch (error) {
    const isCancel = error?.code === 'PM_INSTALL_CANCELLED'
      || /cancelled by user/i.test(error?.message || '');
    if (isCancel) {
      appendLog('\n' + t('dialogs:installFfmpeg.installCancelled', {
        manager: manager.label,
      }) + '\n');
      showToast(
        t('dialogs:installFfmpeg.installCancelled', { manager: manager.label }),
        'info',
        3000,
      );
    } else {
      appendLog('\n' + t('dialogs:installFfmpeg.installFailed', {
        manager: manager.label,
        error: error?.message || error,
      }) + '\n');
      showToast(t('dialogs:installFfmpeg.installFailed', {
        manager: manager.label,
        error: error?.message || error,
      }), 'error', 5000);
    }
    triggerBtn.textContent = originalLabel;
    allButtons.forEach((btn) => { btn.disabled = false; });
  } finally {
    installing = false;
    setCloseButtonMode('close');
  }
}

async function openInstallFfmpegDialog(packageName = 'ffmpeg') {
  if (!overlay) return;
  currentPackage = packageName;

  listEl.innerHTML = '';
  logEl.hidden = true;
  logEl.textContent = '';
  overlay.hidden = false;
  setCloseButtonMode('close');

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
  if (!overlay) return;
  overlay.hidden = true;
  // Always re-run preflight on close so the left panel's "ffmpeg /
  // ffprobe not found" banner clears immediately when the install
  // actually succeeded, and stays visible (correctly) when it didn't.
  // Fire-and-forget — we don't block the dialog close on it, and
  // refreshPreflight() has its own internal error handling.
  refreshPreflight().catch(() => { /* ignore — handled internally */ });
}

/**
 * Handle a click on the bottom-right action button.  Its behaviour
 * depends on whether an install is currently running:
 *
 *   - Idle state (no install): just close the dialog.
 *   - Running state: ask the main process to kill the child, but don't
 *     close the dialog yet — the running `installPackage` promise will
 *     reject with PM_INSTALL_CANCELLED, runInstall()'s catch path will
 *     show the "cancelled" toast and re-enable the install buttons,
 *     and the user can then either pick a different manager or hit
 *     Close again to dismiss the dialog.
 */
async function handleCloseOrCancel() {
  if (!overlay) return;
  if (installing) {
    try {
      await window.electronAPI.cancelInstallPackage();
    } catch (err) {
      showToast(
        t('dialogs:installFfmpeg.cancelFailed', { error: err?.message || err }),
        'error',
        4000,
      );
    }
    return;
  }
  closeInstallFfmpegDialog();
}

function initInstallFfmpegDialog() {
  if (initialized) return;
  initialized = true;

  closeBtn?.addEventListener('click', handleCloseOrCancel);
  overlay?.addEventListener('click', (event) => {
    // Clicking the backdrop never cancels a running install — only the
    // explicit button does that, so a stray misclick doesn't tear down
    // a half-done download.  Backdrop click only closes when idle.
    if (event.target === overlay && !installing) {
      closeInstallFfmpegDialog();
    }
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
