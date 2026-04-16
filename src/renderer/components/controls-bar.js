'use strict';

import { saveSettings, collectFormValues, renderSettings } from './settings-panel.js';
import { setStatus } from './console-log.js';
import { showToast } from './toast.js';
import { addHistoryEntry } from './history.js';
import { getPreflightState, refreshPreflight, subscribePreflight } from './preflight-panel.js';
import { getQueueState, subscribeQueueState } from './queue-state.js';
import { t } from '../lib/i18n.js';
import { confirmDialog } from '../lib/confirm-dialog.js';

/**
 * Localize a preflight check's message for the controls hint strip.
 * Preflight checks in Phase 2+ ship as { titleKey, titleParams, messageKey,
 * messageParams }, but some legacy callers may still send raw strings.
 * This helper accepts both.
 */
function localizeCheckMessage(check) {
  if (!check) return '';
  if (check.messageKey) return t(check.messageKey, check.messageParams || undefined);
  return check.message || '';
}

const btnScan = document.getElementById('btn-scan');
const btnCli = document.getElementById('btn-run-cli');
const btnPauseResume = document.getElementById('btn-pause-resume');
const btnSkipCurrent = document.getElementById('btn-skip-current');
const btnStop = document.getElementById('btn-stop');
const chkLoop = document.getElementById('chk-auto-loop');
const actionHint = document.getElementById('action-hint');

let lastAction = null;
let isRunning = false;

function getCheck(key) {
  const preflight = getPreflightState();
  return preflight.checks.find((check) => check.key === key) || null;
}

function getScanBlockingMessage() {
  const preflight = getPreflightState();
  if (preflight.pending) return t('controls:blocking.checking');
  const mediaRootCheck = getCheck('media_root_path');
  return mediaRootCheck?.status === 'error' ? localizeCheckMessage(mediaRootCheck) : '';
}

function getRunBlockingMessage() {
  const preflight = getPreflightState();
  if (preflight.pending) return t('controls:blocking.checking');
  return localizeCheckMessage(preflight.blockingChecks[0]);
}

function syncActionState() {
  const preflight = getPreflightState();
  const queueState = getQueueState();
  const hasActiveJob = queueState.stats.running > 0 || queueState.stats.paused > 0;
  const queuePaused = queueState.stage === 'paused';
  const queueTransitioning = queueState.stage === 'skipping' || queueState.stage === 'stopping';
  const scanBlocked = preflight.pending || Boolean(getScanBlockingMessage());
  const runBlocked = preflight.pending || !preflight.ok;

  btnScan.disabled = isRunning || scanBlocked;
  btnCli.disabled = isRunning || runBlocked;
  btnPauseResume.disabled = !hasActiveJob || queueTransitioning;
  btnPauseResume.textContent = queuePaused
    ? t('controls:actionState.resume')
    : t('controls:actionState.pause');
  btnSkipCurrent.disabled = !hasActiveJob || queueTransitioning;
  btnStop.disabled = !hasActiveJob || queueTransitioning;
  btnScan.classList.toggle('spinning', isRunning && lastAction === 'scan');

  const reason = isRunning ? '' : (getScanBlockingMessage() || getRunBlockingMessage());
  if (actionHint) {
    actionHint.hidden = !reason;
    actionHint.textContent = reason;
  }
  btnScan.title = getScanBlockingMessage() || t('controls:tooltip.scanDefault');
  btnCli.title = getRunBlockingMessage() || t('controls:tooltip.runDefault');
  btnPauseResume.title = queueTransitioning
    ? t('controls:tooltip.pauseWait')
    : queuePaused
      ? t('controls:tooltip.resumeHint')
      : t('controls:tooltip.pauseHint');
  btnSkipCurrent.title = queueTransitioning
    ? t('controls:tooltip.skipWait')
    : hasActiveJob
      ? t('controls:tooltip.skipHint')
      : t('controls:tooltip.skipNoActive');
  btnStop.title = queueTransitioning
    ? t('controls:tooltip.stopWait')
    : hasActiveJob
      ? t('controls:tooltip.stopHint')
      : t('controls:tooltip.stopNoActive');

  if (!isRunning) {
    setStatus(preflight.pending
      ? t('controls:status.checking')
      : (preflight.ok ? t('controls:status.idle') : t('controls:status.setup')));
    document.title = t('controls:docTitle.default');
  } else if (queueState.stage === 'skipping') {
    setStatus(t('controls:status.skipping'));
    document.title = t('controls:docTitle.skipping');
  } else if (queueState.stage === 'stopping') {
    setStatus(t('controls:status.stopping'));
    document.title = t('controls:docTitle.stopping');
  } else if (queuePaused) {
    setStatus(t('controls:status.paused'));
    document.title = t('controls:docTitle.paused');
  } else {
    setStatus(t('controls:status.running'));
    document.title = t('controls:docTitle.running');
  }
}

function setRunning(running) {
  isRunning = running;
  window.electronAPI.setRunning(running);

  if (running) {
    setStatus(t('controls:status.running'));
    document.title = t('controls:docTitle.running');
  }

  syncActionState();
}

async function ensureScanReady() {
  await saveSettings();
  const preflight = await refreshPreflight();
  const mediaRootCheck = preflight.checks.find((check) => check.key === 'media_root_path');

  if (mediaRootCheck?.status !== 'error') return true;

  showToast(t('controls:guard.scanNeedsMediaRoot'), 'error');
  syncActionState();
  return false;
}

async function ensureRunReady() {
  await saveSettings();
  const preflight = await refreshPreflight();
  if (!preflight.ok) {
    showToast(t('controls:guard.runNeedsEnv'), 'error');
    syncActionState();
    return false;
  }

  // Model-availability is checked in the main-process `run:cli`
  // handler (ipc-handlers.js) via a fast filesystem walk — no Python
  // spawn needed.  If the model is missing, main broadcasts
  // `run:model-missing` and the listener above shows the dialog.
  // We removed the old renderer-side listModels() guard because it
  // spawned Python (multi-second cold start) and caused a long
  // freeze between the button click and the dialog appearing.

  return true;
}

async function triggerScan() {
  const isReady = await ensureScanReady();
  if (!isReady) return false;

  const values = collectFormValues();
  const rootPath = values?.SETTING?.media_root_path || '';
  lastAction = 'scan';
  setRunning(true);
  window.electronAPI.runScan(rootPath || undefined);
  return true;
}

async function triggerRun() {
  // Disable the button immediately so the user can't spam-click
  // while the async preflight check runs.
  btnCli.disabled = true;
  btnScan.disabled = true;

  const isReady = await ensureRunReady();
  if (!isReady) {
    syncActionState();
    return false;
  }

  lastAction = 'cli';
  setRunning(true);
  // Arm the progress-card scroll before we kick off the run.  The actual
  // scroll happens the first time queue state reports a running job,
  // which is after Python has emitted its first [WhisperFlowEvent] —
  // guaranteeing the Batch Progress card is already unhidden at the
  // moment we scroll it into view.
  armProgressCardScroll();
  window.electronAPI.runCli();
  return true;
}

let _progressCardScrollArmed = false;

function armProgressCardScroll() {
  _progressCardScrollArmed = true;
}

function maybeScrollProgressCardIntoView(state) {
  if (!_progressCardScrollArmed) return;
  const job = state?.currentJob;
  if (!job || (job.status !== 'running' && job.status !== 'paused')) return;

  _progressCardScrollArmed = false;
  requestAnimationFrame(() => {
    const progressCard = document.getElementById('progress-card');
    if (!progressCard || progressCard.hidden) return;
    progressCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

btnScan.addEventListener('click', async () => {
  await triggerScan();
});

btnCli.addEventListener('click', async () => {
  await triggerRun();
});

btnPauseResume.addEventListener('click', () => {
  const queueState = getQueueState();
  if (queueState.stage === 'paused') {
    window.electronAPI.resumeProcess();
    return;
  }

  window.electronAPI.pauseProcess();
});

btnSkipCurrent.addEventListener('click', () => {
  window.electronAPI.skipCurrent();
});

btnStop.addEventListener('click', () => {
  window.electronAPI.stopProcess();
});

document.getElementById('btn-reveal-in-finder').addEventListener('click', () => {
  const filePath = document.getElementById('found-filepath').textContent.trim();
  if (filePath) window.electronAPI.showInFolder(filePath);
});

subscribePreflight(() => {
  if (!isRunning) syncActionState();
});

subscribeQueueState((state) => {
  syncActionState();
  maybeScrollProgressCardIntoView(state);
});

// Main-process model-missing gate — fires when run:cli detects the
// configured model isn't downloaded.  This catches ALL code paths
// (button click, auto-loop, retry) because the check lives in the
// main-process run:cli handler, not here in the renderer.
window.electronAPI.onModelMissing?.(async ({ model }) => {
  setRunning(false);
  const goToModels = await confirmDialog({
    title: t('controls:guard.modelMissingTitle', { model }),
    message: t('controls:guard.modelMissingMessage', { model }),
    confirmText: t('controls:guard.modelMissingConfirm'),
    cancelText: t('controls:guard.modelMissingCancel'),
  });
  if (goToModels) {
    const modelsTabBtn = document.querySelector('[data-tab="models"]');
    modelsTabBtn?.click();
    showToast(t('controls:guard.modelMissingGuide', { model }), 'info', 5000);
  }
  syncActionState();
});

window.electronAPI.onRunDone(async (code) => {
  setRunning(false);
  if (code !== 0 && code !== -2 && code !== -3) {
    setStatus('Error');
  }

  if (lastAction === 'scan') {
    const queueState = getQueueState();
    const preflight = getPreflightState();

    if (queueState.stats.total > 0 && queueState.currentJob) {
      showToast(t('controls:toast.scanFound', {
        fileName: queueState.currentJob.fileName,
        total: queueState.stats.total,
      }), 'success');
      if (chkLoop.checked && preflight.ok) {
        lastAction = 'cli';
        setRunning(true);
        window.electronAPI.runCli();
        return;
      }
      if (chkLoop.checked && !preflight.ok) {
        showToast(t('controls:toast.scanLoopEnvBlocked'), 'info');
      }
    } else {
      if (chkLoop.checked) {
        showToast(t('controls:toast.loopCompleteAllDone'), 'success');
        window.electronAPI.notify({
          title: t('controls:notify.title'),
          body: t('controls:notify.allFilesDone'),
        });
      } else {
        showToast(t('controls:toast.scanNoMissing'), 'info');
      }
    }

    await renderSettings();
    await refreshPreflight();
  }

  if (lastAction === 'cli') {
    const queueState = getQueueState();
    const finishedJob = queueState.lastFinishedJob;

    if (code === 0) {
      showToast(t('controls:toast.transcriptionComplete'), 'success');
      window.electronAPI.notify({
        title: t('controls:notify.title'),
        body: t('controls:notify.transcribeSuccess'),
      });

      if (finishedJob?.fileName) {
        addHistoryEntry({
          fileName: finishedJob.fileName,
          filePath: finishedJob.filePath,
          success: true,
        });
      }

      if (chkLoop.checked && queueState.stats.pending > 0) {
        showToast(t('controls:toast.loopNextFile'), 'info', 2000);
        lastAction = 'cli';
        setRunning(true);
        window.electronAPI.runCli();
      } else if (chkLoop.checked) {
        showToast(t('controls:toast.loopQueueDone'), 'success');
      }
    } else if (code === -3) {
      showToast(t('controls:toast.skippedCurrent'), 'info');

      if (chkLoop.checked && queueState.stats.pending > 0) {
        showToast(t('controls:toast.loopSkipNext'), 'info', 2000);
        lastAction = 'cli';
        setRunning(true);
        window.electronAPI.runCli();
      }
    } else if (code === -2) {
      showToast(t('controls:toast.stoppedCurrent'), 'info');
    } else if (code !== -2) {
      showToast(t('controls:toast.transcriptionFailed'), 'error');
      window.electronAPI.notify({
        title: t('controls:notify.title'),
        body: t('controls:notify.transcribeFailed'),
      });

      if (finishedJob?.fileName) {
        addHistoryEntry({
          fileName: finishedJob.fileName,
          filePath: finishedJob.filePath,
          success: false,
        });
      }
    }

    await renderSettings();
  }
});

syncActionState();

// On language switch, re-run syncActionState so the status label,
// tooltips, and hint strip all pick up the new locale immediately.
window.addEventListener('app:language-changed', () => {
  syncActionState();
});

export { setRunning, triggerRun, triggerScan };
