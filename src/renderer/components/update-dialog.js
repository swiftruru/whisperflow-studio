'use strict';

/**
 * Update dialog — themed modal that reacts to `updater:*` events
 * from the main process.
 *
 * State machine (as used by the DOM)
 * ----------------------------------
 *   idle          → dialog hidden
 *   available     → dialog visible with three buttons
 *                   (Skip / Remind later / Update now)
 *   downloading   → dialog visible with progress bar and
 *                   "Cancel download" button (Windows NSIS only)
 *   ready         → dialog visible with "Restart & install now"
 *                   as the primary button
 *
 * This component never initiates a check on its own — it's a
 * reactive renderer.  The orchestrator in `src/main/updater/` does
 * the actual network + platform work.
 *
 * Manual-check feedback (checking / up-to-date / check-failed)
 * is rendered as toasts, not via this dialog, because it's
 * transient and doesn't need the user to decide anything.
 */

import { showToast } from './toast.js';
import { t, onLanguageChanged } from '../lib/i18n.js';
import { renderMarkdown } from '../lib/markdown-render.js';

const overlay = document.getElementById('update-dialog');
const currentVersionEl = document.getElementById('update-current-version');
const latestVersionEl = document.getElementById('update-latest-version');
const notesEl = document.getElementById('update-notes');
const viewFullBtn = document.getElementById('btn-update-view-full');
const platformNoteEl = document.getElementById('update-platform-note');
const progressWrap = document.getElementById('update-progress');
const progressFill = document.getElementById('update-progress-fill');
const progressLabel = document.getElementById('update-progress-label');
const skipBtn = document.getElementById('btn-update-skip');
const laterBtn = document.getElementById('btn-update-later');
const primaryBtn = document.getElementById('btn-update-download');

let currentState = 'idle';          // idle | available | downloading | ready
let currentRelease = null;           // cached from updater:update-available
let initialized = false;

function setState(next) {
  currentState = next;
  if (!overlay) return;
  overlay.dataset.updaterState = next;

  // Button visibility / labels
  if (next === 'idle') {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;

  if (next === 'available') {
    skipBtn.hidden = false;
    laterBtn.hidden = false;
    primaryBtn.hidden = false;
    primaryBtn.disabled = false;
    progressWrap.hidden = true;
    primaryBtn.textContent = currentRelease?.supportsAutoInstall
      ? t('updater:actions.downloadWindows')
      : t('updater:actions.download');
  } else if (next === 'downloading') {
    skipBtn.hidden = true;
    laterBtn.hidden = true;
    primaryBtn.hidden = false;
    primaryBtn.disabled = true;
    progressWrap.hidden = false;
    primaryBtn.textContent = t('updater:progress.waiting');
  } else if (next === 'ready') {
    skipBtn.hidden = true;
    laterBtn.hidden = false;   // user can still defer the restart
    primaryBtn.hidden = false;
    primaryBtn.disabled = false;
    progressWrap.hidden = false;
    progressFill.style.width = '100%';
    progressLabel.textContent = t('updater:progress.downloaded');
    primaryBtn.textContent = t('updater:actions.installNow');
  }
}

function populate(release) {
  currentRelease = release;
  if (!overlay || !release) return;

  currentVersionEl.textContent = `v${release.current}`;
  latestVersionEl.textContent = `v${release.latest}`;
  // Prefer the full body so the renderer can format headings / lists /
  // bold nicely; fall back to the truncated preview text if body is
  // empty for any reason.
  const markdownSource = release.body || release.notesPreview || '';
  renderMarkdown(markdownSource, notesEl);
  viewFullBtn.dataset.href = release.htmlUrl || '';

  // Platform hint — explains why the button does what it does on
  // this machine.  Helps users on macOS understand why we can't
  // auto-install here.
  let platformNoteKey = 'updater:dialog.platformNoteMac';
  if (release.supportsAutoInstall) {
    platformNoteKey = 'updater:dialog.platformNoteWindowsAutoUpdate';
  } else if (release.isPortableWindows) {
    platformNoteKey = 'updater:dialog.platformNotePortable';
  }
  platformNoteEl.textContent = t(platformNoteKey);

  // Progress defaults
  progressFill.style.width = '0%';
  progressLabel.textContent = t('updater:progress.waiting');

  setState('available');
}

async function handlePrimary() {
  if (!currentRelease) return;

  if (currentState === 'ready') {
    // User ready to restart + install (Windows NSIS flow).  Calling
    // `updater.install()` triggers `autoUpdater.quitAndInstall()` on
    // the main side, which kills this process and runs the NSIS
    // installer.  No need to close the dialog ourselves — the app
    // will terminate.
    try {
      await window.electronAPI.updater.install();
    } catch (err) {
      showToast(
        t('updater:toast.downloadFailed', { error: err?.message || String(err) }),
        'error',
        4000,
      );
    }
    return;
  }

  // State is 'available' — branch on platform strategy.
  if (currentRelease.supportsAutoInstall) {
    // Windows NSIS: begin the download.  The orchestrator's
    // `startUpdate()` (reached via the `updater:start` IPC) calls
    // `autoUpdater.downloadUpdate()` which streams progress events.
    // We optimistically flip to the downloading state so the user
    // sees the progress bar immediately; if `updater.start()`
    // rejects we roll back to `available` and surface a toast.
    setState('downloading');
    showToast(t('updater:toast.downloadStarted'), 'info', 2500);
    try {
      await window.electronAPI.updater.start();
    } catch (err) {
      setState('available');
      showToast(
        t('updater:toast.downloadFailed', { error: err?.message || String(err) }),
        'error',
        4000,
      );
    }
    return;
  }

  // macOS / portable / linux / unknown: open the release page in
  // the user's default browser.  `updater.start()` on these
  // platforms wraps `shell.openExternal(release.htmlUrl)` so the
  // renderer doesn't need its own URL-opening code path.  We keep
  // the dialog visible so the user can close it explicitly when
  // they're done downloading in the browser.
  try {
    await window.electronAPI.updater.start();
  } catch (err) {
    showToast(
      t('updater:toast.openPageFailed', { error: err?.message || String(err) }),
      'error',
      4000,
    );
  }
}

async function handleSkip() {
  if (!currentRelease) return;
  const version = currentRelease.latest;
  try {
    await window.electronAPI.updater.skip(version);
    showToast(t('updater:toast.skipped', { version }), 'info', 3000);
  } finally {
    setState('idle');
  }
}

function handleLater() {
  // Just close — no state persisted.  Next launch's 5s check will
  // surface the same update again.
  setState('idle');
}

function handleViewFullNotes() {
  const url = viewFullBtn.dataset.href;
  if (!url) return;
  window.electronAPI.openExternal(url).catch((err) => {
    showToast(
      t('updater:toast.openPageFailed', { error: err?.message || String(err) }),
      'error',
      4000,
    );
  });
}

function initUpdateDialog() {
  if (initialized || !overlay) return;
  initialized = true;

  // Button bindings
  primaryBtn?.addEventListener('click', handlePrimary);
  skipBtn?.addEventListener('click', handleSkip);
  laterBtn?.addEventListener('click', handleLater);
  viewFullBtn?.addEventListener('click', handleViewFullNotes);

  // Backdrop click only closes when in "available" state — during
  // active download we don't want a stray click to kill the dialog.
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && currentState === 'available') {
      handleLater();
    }
  });

  // Keyboard: Esc closes in "available" state only
  document.addEventListener('keydown', (event) => {
    if (!overlay || overlay.hidden) return;
    if (event.key === 'Escape' && currentState === 'available') {
      event.preventDefault();
      handleLater();
    }
  });

  // Re-render label strings when the user switches UI language
  // mid-dialog — all text comes from data-i18n walker (handled by
  // the global listener in index.js) except the three button
  // labels and progress label which we compute in JS.
  onLanguageChanged(() => {
    if (currentState !== 'idle') setState(currentState);
  });

  // ── Wire IPC broadcasts ────────────────────────────────────────────
  const updater = window.electronAPI?.updater;
  if (!updater) return;

  updater.onChecking((payload) => {
    if (payload?.manual) {
      showToast(t('updater:toast.checking'), 'info', 2000);
    }
  });

  updater.onUpdateAvailable((payload) => {
    populate(payload);
  });

  updater.onUpToDate((payload) => {
    showToast(
      t('updater:toast.upToDate', { version: payload?.current || '' }),
      'success',
      3000,
    );
  });

  updater.onError((payload) => {
    showToast(
      t('updater:toast.checkFailed', { error: payload?.message || 'unknown' }),
      'error',
      4500,
    );
    // If we were mid-download and hit an error, fall back to
    // "available" so the user can retry.
    if (currentState === 'downloading') {
      setState('available');
    }
  });

  updater.onDownloadProgress((payload) => {
    if (currentState !== 'downloading') setState('downloading');
    const percent = Math.max(0, Math.min(100, Math.round(payload?.percent || 0)));
    progressFill.style.width = `${percent}%`;
    progressLabel.textContent = t('updater:progress.label', { percent });
  });

  updater.onDownloadDone(() => {
    setState('ready');
  });

  updater.onSkipped(() => {
    // No-op here — the skip toast is shown by handleSkip() on the
    // renderer side that initiated it.  This broadcast is for any
    // OTHER open window that should react to the state change.
  });
}

function openUpdateDialogFromCache() {
  if (currentRelease) {
    setState('available');
  }
}

export { initUpdateDialog, openUpdateDialogFromCache };
