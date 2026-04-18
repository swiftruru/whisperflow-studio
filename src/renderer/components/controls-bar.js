'use strict';

import { saveSettings, collectFormValues, renderSettings } from './settings-panel.js';
import { appendLog, setStatus } from './console-log.js';
import { showToast } from './toast.js';
import { addHistoryEntry } from './history.js';
import { getPreflightState, refreshPreflight, subscribePreflight } from './preflight-panel.js';
import { getQueueState, subscribeQueueState } from './queue-state.js';
import { t } from '../lib/i18n.js';
import { confirmDialog } from '../lib/confirm-dialog.js';
import { openTranscriptPreview, closeTranscriptPreview } from './transcript-preview.js';

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
    setStatus(preflight.pending ? 'checking' : (preflight.ok ? 'idle' : 'setup'));
    document.title = t('controls:docTitle.default');
  } else if (queueState.stage === 'skipping') {
    setStatus('skipping');
    document.title = t('controls:docTitle.skipping');
  } else if (queueState.stage === 'stopping') {
    setStatus('stopping');
    document.title = t('controls:docTitle.stopping');
  } else if (queuePaused) {
    setStatus('paused');
    document.title = t('controls:docTitle.paused');
  } else {
    setStatus('running');
    document.title = t('controls:docTitle.running');
  }
}

function setRunning(running) {
  isRunning = running;
  window.electronAPI.setRunning(running);

  if (running) {
    setStatus('running');
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

/**
 * Skip the current file with a confirmation dialog — although the
 * batch will continue, the current file's progress is thrown away
 * immediately, so an accidental click mid-transcription is costly.
 */
async function confirmAndSkipCurrent() {
  const qs = getQueueState();
  const fileName = qs?.currentJob?.fileName || '';
  const message = fileName
    ? t('dialogs:skipCurrent.messageWithFile', { fileName })
    : t('dialogs:skipCurrent.messageGeneric');
  const confirmed = await confirmDialog({
    title: t('dialogs:skipCurrent.title'),
    message,
    confirmText: t('dialogs:skipCurrent.confirmLabel'),
    cancelText: t('dialogs:skipCurrent.cancelLabel'),
    destructive: true,
  });
  if (!confirmed) return;
  window.electronAPI.skipCurrent();
}

btnSkipCurrent.addEventListener('click', () => {
  confirmAndSkipCurrent();
});

/**
 * Stop the active batch with a confirmation dialog — the stop IPC
 * terminates the Python process immediately, so we don't want a
 * stray click mid-transcription to throw away 10 minutes of work.
 */
async function confirmAndStopBatch() {
  const qs = getQueueState();
  const fileName = qs?.currentJob?.fileName || '';
  const message = fileName
    ? t('dialogs:stopBatch.messageWithFile', { fileName })
    : t('dialogs:stopBatch.messageGeneric');
  const confirmed = await confirmDialog({
    title: t('dialogs:stopBatch.title'),
    message,
    confirmText: t('dialogs:stopBatch.confirmLabel'),
    cancelText: t('dialogs:stopBatch.cancelLabel'),
    destructive: true,
  });
  if (!confirmed) return;
  window.electronAPI.stopProcess();
}

btnStop.addEventListener('click', () => {
  confirmAndStopBatch();
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

function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function logBatchSummary() {
  const qs = getQueueState();
  const { done, failed, skipped, total } = qs.stats;
  const elapsed = formatElapsed(qs.batchElapsedSeconds);
  appendLog(t('controls:batchSummary.console', { done, failed, skipped, total, elapsed }));
}

window.electronAPI.onRunDone(async (code) => {
  setRunning(false);
  if (code !== 0 && code !== -2 && code !== -3) {
    setStatus('error');
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
        logBatchSummary();
        showToast(t('controls:toast.loopCompleteAllDone'), 'success');
        const qs = getQueueState();
        window.electronAPI.notify({
          title: t('controls:notify.title'),
          body: t('controls:notify.batchComplete', {
            done: qs.stats.done,
            failed: qs.stats.failed,
            elapsed: formatElapsed(qs.batchElapsedSeconds),
          }),
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
      // Only announce success if a job actually finished — prevents
      // false "轉錄完成" notifications when run:done(0) arrives
      // without a real transcription having run (e.g. stale event
      // from a prior scan, or the queue was already empty).
      if (finishedJob?.fileName) {
        showToast(t('controls:toast.transcriptionComplete'), 'success');
        window.electronAPI.notify({
          title: t('controls:notify.title'),
          body: t('controls:notify.transcribeSuccess'),
        });
        addHistoryEntry({
          fileName: finishedJob.fileName,
          filePath: finishedJob.filePath,
          success: true,
        });
        // Open the transcript preview card so the user can eyeball
        // the output without jumping to Finder.  output_dir may be
        // set in config; empty → beside the media file (matches
        // transcriber default).
        try {
          const cfg = await window.electronAPI.readConfig();
          const outputDir = cfg?.SETTING?.output_dir || '';
          openTranscriptPreview({
            mediaPath: finishedJob.filePath,
            outputDir,
          });
        } catch (_) { /* non-blocking */ }
      }

      if (chkLoop.checked && queueState.stats.pending > 0) {
        showToast(t('controls:toast.loopNextFile'), 'info', 2000);
        lastAction = 'cli';
        setRunning(true);
        closeTranscriptPreview();
        window.electronAPI.runCli();
      } else if (chkLoop.checked) {
        logBatchSummary();
        showToast(t('controls:toast.loopQueueDone'), 'success');
      } else if (queueState.stats.pending === 0) {
        logBatchSummary();
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
      if (finishedJob?.fileName) {
        showToast(t('controls:toast.transcriptionFailed'), 'error');
        window.electronAPI.notify({
          title: t('controls:notify.title'),
          body: t('controls:notify.transcribeFailed'),
        });
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

// Tray / global-shortcut bridge.  Main process emits `tray:action` for
// each menu item and global-shortcut binding.
if (window.electronAPI?.onTrayAction) {
  window.electronAPI.onTrayAction((action) => {
    if (action === 'run') {
      triggerRun();
    } else if (action === 'scan') {
      triggerScan();
    } else if (action === 'stop') {
      confirmAndStopBatch();
    }
  });
}

export { setRunning, triggerRun, triggerScan };
