'use strict';

import { saveSettings, collectFormValues, renderSettings } from './settings-panel.js';
import { appendLog, setStatus } from './console-log.js';
import { showToast } from './toast.js';
import { addHistoryEntry } from './history.js';
import { getPreflightState, refreshPreflight, subscribePreflight } from './preflight-panel.js';
import { getQueueState, subscribeQueueState } from './queue-state.js';
import { t } from '../lib/i18n.js';
import { confirmDialog } from '../lib/confirm-dialog.js';
import { openTranscriptPreview } from './transcript-preview.js';

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
const btnPreviewLatest = document.getElementById('btn-preview-latest');
const btnPreviewLatestFilename = document.getElementById('btn-preview-latest-filename');
const chkLoop = document.getElementById('chk-auto-loop');
const actionHint = document.getElementById('action-hint');

let lastAction = null;
let isRunning = false;
// Remember the most recent successful transcription so the "View
// latest transcript" CTA can re-open its modal with one click.  Cleared
// only on explicit clear-history; otherwise sticks across language
// switches and batch continuations.
let latestTranscript = null; // { mediaPath, outputDir, fileName } | null

function updatePreviewLatestButton() {
  if (!btnPreviewLatest) return;
  if (!latestTranscript) {
    btnPreviewLatest.hidden = true;
    return;
  }
  btnPreviewLatest.hidden = false;
  if (btnPreviewLatestFilename) {
    btnPreviewLatestFilename.textContent = latestTranscript.fileName || '';
    btnPreviewLatestFilename.title = latestTranscript.fileName || '';
  }
}

btnPreviewLatest?.addEventListener('click', () => {
  if (!latestTranscript) return;
  openTranscriptPreview({
    mediaPath: latestTranscript.mediaPath,
    outputDir: latestTranscript.outputDir,
  });
});

/**
 * Seed `latestTranscript` from persisted history so the "View latest
 * transcript" CTA is visible on app launch whenever the user has ANY
 * prior successful transcription — not just one from the current
 * session.  Without this the button sits hidden until the user runs
 * a brand-new transcription, making it feel like the feature doesn't
 * exist.
 *
 * Exported so index.js can call it after initHistory() settles.
 */
async function hydrateLatestTranscriptFromHistory() {
  if (latestTranscript) return; // current session already set it
  try {
    const entries = await window.electronAPI.readHistory();
    if (!Array.isArray(entries)) return;
    let outputDir = '';
    try {
      const cfg = await window.electronAPI.readConfig();
      outputDir = cfg?.SETTING?.output_dir || '';
    } catch (_) { /* best-effort */ }

    // Walk history newest-first and pick the first successful entry
    // whose transcript file still exists on disk.  Without the
    // existence check we'd happily highlight a CTA that opens into a
    // "file not found" error — worse UX than just hiding the button.
    for (const entry of entries) {
      if (!entry || !entry.success || !entry.filePath) continue;
      let exists = false;
      try {
        exists = await window.electronAPI.transcript.exists({
          mediaPath: entry.filePath,
          outputDir,
        });
      } catch (_) { exists = false; }
      if (exists) {
        latestTranscript = {
          mediaPath: entry.filePath,
          outputDir,
          fileName: entry.fileName,
        };
        updatePreviewLatestButton();
        return;
      }
    }
    // Nothing matched — button stays hidden.
  } catch (_) {
    /* ignore — button just stays hidden */
  }
}

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

  // Guard: if the queue has no pending jobs (e.g. user clicked Run
  // without scanning first, or the previous batch drained the queue),
  // bail out here.  Otherwise main would still send run:done(0) and
  // the renderer's CLI branch would show a stale "轉錄完成" toast +
  // re-log the previous batch summary, because lastFinishedJob /
  // stats still reference the prior batch.
  if (getQueueState().stats.pending === 0) {
    showToast(t('controls:toast.runNoQueued'), 'info');
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
        window.electronAPI.notify({
          title: t('controls:notify.title'),
          body: t('controls:notify.transcribeSuccess'),
        });
        addHistoryEntry({
          fileName: finishedJob.fileName,
          filePath: finishedJob.filePath,
          success: true,
        });

        // Resolve the output_dir once — both the toast action and the
        // optional auto-open need it, and we don't want the toast to
        // close before the async read finishes.
        let outputDir = '';
        try {
          const cfg = await window.electronAPI.readConfig();
          outputDir = cfg?.SETTING?.output_dir || '';
        } catch (_) { /* best-effort; falls back to empty */ }

        const previewArgs = { mediaPath: finishedJob.filePath, outputDir };

        // Track this as the "latest transcript" so the persistent CTA
        // button in the sidebar can re-open it without hunting through
        // the history list.  Stays set across language switches and
        // subsequent queue progress.
        latestTranscript = {
          mediaPath: finishedJob.filePath,
          outputDir,
          fileName: finishedJob.fileName,
        };
        updatePreviewLatestButton();

        // Toast with a "View preview" action so the user can pop the
        // full-screen modal with one click.  The modal is NOT opened
        // automatically unless the user opted in via the Settings
        // checkbox (localStorage `transcript.autoOpenOnComplete`).
        showToast(t('controls:toast.transcriptionComplete'), 'success', 5000, {
          action: {
            label: t('transcript:actions.preview'),
            onClick: () => openTranscriptPreview(previewArgs),
          },
        });

        let autoOpen = false;
        try { autoOpen = localStorage.getItem('transcript.autoOpenOnComplete') === 'true'; } catch (_) {}
        if (autoOpen) {
          openTranscriptPreview(previewArgs);
        }
      }

      if (chkLoop.checked && queueState.stats.pending > 0) {
        showToast(t('controls:toast.loopNextFile'), 'info', 2000);
        lastAction = 'cli';
        setRunning(true);
        // Note: we deliberately do NOT close the transcript preview
        // modal here — if the user opened it for the previous file
        // they can keep reading while the batch continues with the
        // next one.  The modal only closes via Esc / backdrop / the
        // Close buttons, or when a new preview replaces its content.
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
  updatePreviewLatestButton();
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

export { setRunning, triggerRun, triggerScan, hydrateLatestTranscriptFromHistory };
