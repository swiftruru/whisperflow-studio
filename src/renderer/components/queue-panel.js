'use strict';

import { setStage } from './console-log.js';
import { getQueueState, subscribeQueueState } from './queue-state.js';
import {
  getQueueViewState,
  setQueueSearchQuery,
  setQueueStatusFilter,
  subscribeQueueViewState,
} from './queue-view-state.js';
import { showToast } from './toast.js';
import { t } from '../lib/i18n.js';

/**
 * Localize a job's `stageMessage`.  Main process stores both a
 * raw English string (stable, shown as fallback and saved to the
 * transcript log) and an optional i18n key with params; we pick the
 * key when present so the UI matches the current language.
 */
function localizeStageMessage(job) {
  if (!job) return '';
  if (job.stageMessageKey) return t(job.stageMessageKey, job.stageMessageParams || undefined);
  return job.stageMessage || '';
}

const foundCard = document.getElementById('found-card');
const foundFilename = document.getElementById('found-filename');
const foundFilepath = document.getElementById('found-filepath');
const missingCountBadge = document.getElementById('missing-count-badge');

const progressCard = document.getElementById('progress-card');
const progressHeadline = document.getElementById('queue-progress-headline');
const progressStats = document.getElementById('queue-progress-stats');
const progressCurrent = document.getElementById('queue-progress-current');
const progressTiming = document.getElementById('queue-progress-timing');
const progressMessage = document.getElementById('queue-progress-message');
const progressStage = document.getElementById('queue-stage-chip');
const progressBarFill = document.getElementById('queue-progress-bar-fill');

const retryFailedButton = document.getElementById('btn-queue-retry-failed');
const clearFinishedButton = document.getElementById('btn-queue-clear-finished');

const queueCard = document.getElementById('queue-card');
const queueTotalBadge = document.getElementById('queue-total-badge');
const queueSearchInput = document.getElementById('queue-search-input');
const queueFilterContainer = document.getElementById('queue-filter-chips');
const queueViewSummary = document.getElementById('queue-view-summary');
const queueList = document.getElementById('queue-list');

let actionsBound = false;
let isRetrying = false;
let isClearing = false;
let activeJobAction = null;
let latestQueueState = getQueueState();
let latestViewState = getQueueViewState();

function stageLabel(stage) {
  const keyMap = {
    'scanning': 'scanning',
    'ready': 'ready',
    'running': 'running',
    'paused': 'paused',
    'completed': 'completed',
    'error': 'error',
    'preparing': 'preparing',
    'loading-model': 'loadingModel',
    'vad': 'vad',
    'transcribing': 'transcribing',
    'writing-subtitle': 'writingSubtitle',
    'finalizing': 'finalizing',
    'failed': 'failed',
    'skipped': 'skipped',
    'skipping': 'skipping',
    'stopping': 'stopping',
  };
  return t(`progress:stage.${keyMap[stage] || 'idle'}`);
}

function jobStatusLabel(status) {
  const validKeys = ['pending', 'running', 'paused', 'done', 'failed', 'skipped'];
  if (validKeys.includes(status)) {
    return t(`progress:jobStatus.${status}`);
  }
  return status;
}

function getJobStageLabel(job) {
  if (!job) return t('progress:stage.idle');
  if (job.stage && job.stage !== 'idle') {
    return stageLabel(job.stage);
  }
  return jobStatusLabel(job.status);
}

function getBatchProgressPercent(state) {
  if (state.stats.total === 0) {
    return state.scanSummary.scannedFiles > 0 ? 100 : 0;
  }

  const processedCount = state.stats.done + state.stats.skipped;
  const currentProgress = (state.currentJob?.status === 'running' || state.currentJob?.status === 'paused')
    ? Math.max(0, Math.min(100, Number(state.currentJob.progress) || 0))
    : 0;

  const rawValue = ((processedCount + (currentProgress / 100)) / state.stats.total) * 100;
  return Math.max(0, Math.min(100, rawValue));
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return null;

  const totalSeconds = Math.round(Number(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function buildProgressTiming(state) {
  const parts = [];
  const currentJob = state.currentJob;

  if (currentJob?.elapsedSeconds != null) {
    const elapsed = formatDuration(currentJob.elapsedSeconds);
    if (elapsed) {
      parts.push(`Current elapsed ${elapsed}`);
    }
  }

  if (currentJob?.etaSeconds != null) {
    const eta = formatDuration(currentJob.etaSeconds);
    if (eta && currentJob.etaSeconds > 0) {
      parts.push(`Current ETA ${eta}`);
    }
  }

  if (state.batchElapsedSeconds != null) {
    const batchElapsed = formatDuration(state.batchElapsedSeconds);
    if (batchElapsed) {
      parts.push(`Batch elapsed ${batchElapsed}`);
    }
  }

  if (state.batchEtaSeconds != null) {
    const batchEta = formatDuration(state.batchEtaSeconds);
    if (batchEta && state.batchEtaSeconds > 0) {
      parts.push(`Batch ETA ${batchEta}`);
    }
  }

  return parts.join(' · ');
}

function buildJobProgressText(job) {
  if (!job) return '';

  const parts = [];
  if (typeof job.progress === 'number' && job.progress > 0 && job.progress < 100) {
    parts.push(`${Math.round(job.progress)}%`);
  }

  if (job.elapsedSeconds != null) {
    const elapsed = formatDuration(job.elapsedSeconds);
    if (elapsed) {
      parts.push(`Elapsed ${elapsed}`);
    }
  }

  if (job.etaSeconds != null && job.etaSeconds > 0) {
    const eta = formatDuration(job.etaSeconds);
    if (eta) {
      parts.push(`ETA ${eta}`);
    }
  }

  return parts.join(' · ');
}

function matchesSearch(job, query) {
  if (!query) return true;

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [
    job.fileName,
    job.filePath,
    job.dirPath,
  ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
}

function matchesStatus(job, statusFilter) {
  return statusFilter === 'all' || job.status === statusFilter;
}

function getVisibleJobs(state, viewState) {
  return state.jobs.filter((job) => matchesSearch(job, viewState.searchQuery) && matchesStatus(job, viewState.statusFilter));
}

function canRetryJob(job) {
  return job.status === 'failed' || job.status === 'skipped';
}

function canRemoveJob(job) {
  return ['pending', 'failed', 'skipped'].includes(job.status);
}

function canMoveJob(job) {
  return ['pending', 'failed', 'skipped'].includes(job.status);
}

function canMoveJobDirection(jobs, index, direction) {
  const job = jobs[index];
  if (!canMoveJob(job)) return false;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= jobs.length) return false;

  return canMoveJob(jobs[targetIndex]);
}

function isJobActionPending(jobId, actionType = null) {
  if (!activeJobAction || activeJobAction.jobId !== jobId) return false;
  return actionType ? activeJobAction.type === actionType : true;
}

function renderQueueViewState(viewState = latestViewState) {
  if (queueSearchInput && queueSearchInput.value !== viewState.searchQuery) {
    queueSearchInput.value = viewState.searchQuery;
  }

  queueFilterContainer?.querySelectorAll('.queue-filter-chip').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === viewState.statusFilter);
  });
}

function renderFoundCard(state) {
  const currentJob = state.currentJob;
  const remaining = state.stats.pending + state.stats.running + state.stats.paused + state.stats.failed;

  if (!currentJob) {
    foundCard.hidden = true;
    return;
  }

  foundFilename.textContent = currentJob.fileName;
  foundFilepath.textContent = currentJob.filePath;
  missingCountBadge.textContent = t('queue:nextCard.remainingBadge', { count: remaining });
  missingCountBadge.hidden = false;
  foundCard.hidden = false;
}

function renderProgress(state) {
  const hasBatchResults = state.stats.total > 0 || state.scanSummary.scannedFiles > 0;
  const processedCount = state.stats.done + state.stats.skipped;
  if (!hasBatchResults) {
    progressCard.hidden = true;
    return;
  }

  progressCard.hidden = false;
  progressStage.textContent = stageLabel(state.stage);
  progressStage.dataset.stage = state.stage;
  // Show per-file progress while a job is active (cleaner 0→100% animation
  // for each file), fall back to batch progress only when the queue is
  // idle or paused.  The batch state is already conveyed via the stats
  // line ("Pending X · Running Y · Done Z") so we don't lose information.
  progressBarFill.style.width = `${getDisplayProgressPercent(state).toFixed(1)}%`;

  if (state.stats.total === 0) {
    progressHeadline.textContent = t('progress:batchCard.noMissing');
    progressStats.textContent = t('progress:batchCard.scanSummary', {
      files: state.scanSummary.scannedFiles,
      dirs: state.scanSummary.scannedDirectories,
    });
    progressCurrent.textContent = t('queue:panel.emptyPending');
    progressTiming.hidden = true;
    progressTiming.textContent = '';
    progressMessage.hidden = true;
    progressMessage.textContent = '';
    return;
  }

  const fileIndex = Math.min(processedCount + 1, state.stats.total);
  const fileCounter = `${fileIndex}/${state.stats.total}`;

  if (state.currentJob) {
    const currentLabel = state.currentJob.status === 'pending'
      ? 'Next up'
      : getJobStageLabel(state.currentJob);
    progressHeadline.textContent = `${currentLabel} · File ${fileCounter} · ${state.currentJob.fileName}`;
  } else if (processedCount === state.stats.total) {
    progressHeadline.textContent = 'All queued files processed';
  } else {
    progressHeadline.textContent = 'Queue ready';
  }

  progressStats.textContent =
    `Pending ${state.stats.pending} · Running ${state.stats.running} · Paused ${state.stats.paused} · Done ${state.stats.done} · Skipped ${state.stats.skipped} · Failed ${state.stats.failed}`;

  const scanSummary = `Scanned ${state.scanSummary.scannedFiles} files in ${state.scanSummary.scannedDirectories} folders`;
  const completion = `${processedCount}/${state.stats.total} processed`;
  progressCurrent.textContent = `${completion} · ${scanSummary}`;

  const timingText = buildProgressTiming(state);
  progressTiming.hidden = !timingText;
  progressTiming.textContent = timingText;

  // Only show the stage message for the CURRENTLY running job.  Falling
  // back to `lastRunnerEvent.message` after a job finishes would carry
  // "Subtitle files generated" (from the just-finished file) onto the
  // display of the next pending file — misleading.
  const stageMessage = state.currentJob && state.currentJob.status === 'running'
    ? localizeStageMessage(state.currentJob)
    : '';
  progressMessage.hidden = !stageMessage;
  progressMessage.textContent = stageMessage;
}

// Decides what percentage to show in the progress bar.  While a job is
// actively running we show its 0→100% so each file animates fully; while
// idle / between jobs we show the overall batch progress so the user can
// see how much of the queue is still outstanding.
function getDisplayProgressPercent(state) {
  const job = state.currentJob;
  if (job && (job.status === 'running' || job.status === 'paused')) {
    const raw = Number(job.progress);
    if (Number.isFinite(raw)) {
      return Math.max(0, Math.min(100, raw));
    }
  }
  return getBatchProgressPercent(state);
}

function renderActions(state) {
  const finishedCount = state.stats.done + state.stats.skipped;

  retryFailedButton.hidden = state.stats.failed === 0;
  retryFailedButton.disabled = isRetrying;

  clearFinishedButton.hidden = finishedCount === 0;
  clearFinishedButton.disabled = isClearing;
}

function renderQueueList(state, viewState) {
  if (state.stats.total === 0) {
    queueCard.hidden = true;
    queueList.innerHTML = '';
    return;
  }

  const visibleJobs = getVisibleJobs(state, viewState);
  queueCard.hidden = false;
  queueTotalBadge.textContent = `${state.stats.total} files`;
  const summaryParts = [
    visibleJobs.length === state.jobs.length
      ? `${visibleJobs.length} visible`
      : `${visibleJobs.length} of ${state.jobs.length} visible`,
  ];
  if (viewState.statusFilter !== 'all') {
    summaryParts.push(`filter: ${viewState.statusFilter}`);
  }
  if (viewState.searchQuery.trim()) {
    summaryParts.push(`search: "${viewState.searchQuery.trim()}"`);
  }
  queueViewSummary.textContent = summaryParts.join(' · ');
  queueList.innerHTML = '';

  if (visibleJobs.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'queue-list-empty';
    emptyState.textContent = 'No matching queue items';
    queueList.appendChild(emptyState);
    return;
  }

  visibleJobs.forEach((job) => {
    const absoluteIndex = state.jobs.findIndex((item) => item.id === job.id);
    const row = document.createElement('div');
    row.className = `queue-item ${job.status}`;
    if (job.id === state.currentJobId) {
      row.classList.add('current');
    }

    const info = document.createElement('div');
    info.className = 'queue-item-info';

    const name = document.createElement('div');
    name.className = 'queue-item-name';
    name.textContent = `${absoluteIndex + 1}. ${job.fileName}`;

    const meta = document.createElement('div');
    meta.className = 'queue-item-meta';
    meta.textContent = `${getJobStageLabel(job)} · ${job.dirPath}`;

    info.appendChild(name);
    info.appendChild(meta);

    const progress = buildJobProgressText(job);
    if (progress) {
      const progressLine = document.createElement('div');
      progressLine.className = 'queue-item-progress';
      progressLine.textContent = progress;
      info.appendChild(progressLine);
    }

    const localizedStage = localizeStageMessage(job);
    if (localizedStage) {
      const stageMessageEl = document.createElement('div');
      stageMessageEl.className = 'queue-item-stage-message';
      stageMessageEl.textContent = localizedStage;
      info.appendChild(stageMessageEl);
    }

    const status = document.createElement('span');
    status.className = `queue-item-status ${job.status}`;
    status.textContent = jobStatusLabel(job.status);

    if (job.error) {
      const error = document.createElement('div');
      error.className = 'queue-item-error';
      error.textContent = job.error;
      info.appendChild(error);
    }

    const actions = document.createElement('div');
    actions.className = 'queue-item-actions';

    if (canRetryJob(job)) {
      const retryButton = document.createElement('button');
      retryButton.className = 'queue-item-action-btn';
      retryButton.type = 'button';
      retryButton.textContent = 'Retry';
      retryButton.disabled = isJobActionPending(job.id, 'retry');
      retryButton.addEventListener('click', (event) => {
        event.stopPropagation();
        handleRetryJob(job.id);
      });
      actions.appendChild(retryButton);
    }

    if (canRemoveJob(job)) {
      const removeButton = document.createElement('button');
      removeButton.className = 'queue-item-action-btn queue-item-action-danger';
      removeButton.type = 'button';
      removeButton.textContent = 'Remove';
      removeButton.disabled = isJobActionPending(job.id, 'remove');
      removeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        handleRemoveJob(job.id);
      });
      actions.appendChild(removeButton);
    }

    if (canMoveJob(job)) {
      const moveUpButton = document.createElement('button');
      moveUpButton.className = 'queue-item-action-btn queue-item-action-move';
      moveUpButton.type = 'button';
      moveUpButton.textContent = '↑';
      moveUpButton.disabled = isJobActionPending(job.id, 'move') || !canMoveJobDirection(state.jobs, absoluteIndex, 'up');
      moveUpButton.addEventListener('click', (event) => {
        event.stopPropagation();
        handleMoveJob(job.id, 'up');
      });
      actions.appendChild(moveUpButton);

      const moveDownButton = document.createElement('button');
      moveDownButton.className = 'queue-item-action-btn queue-item-action-move';
      moveDownButton.type = 'button';
      moveDownButton.textContent = '↓';
      moveDownButton.disabled = isJobActionPending(job.id, 'move') || !canMoveJobDirection(state.jobs, absoluteIndex, 'down');
      moveDownButton.addEventListener('click', (event) => {
        event.stopPropagation();
        handleMoveJob(job.id, 'down');
      });
      actions.appendChild(moveDownButton);
    }

    const aside = document.createElement('div');
    aside.className = 'queue-item-aside';
    aside.appendChild(status);
    if (actions.childElementCount > 0) {
      aside.appendChild(actions);
    }

    row.appendChild(info);
    row.appendChild(aside);

    queueList.appendChild(row);
  });
}

function renderQueueState(state = latestQueueState, viewState = latestViewState) {
  latestQueueState = state;
  latestViewState = viewState;
  renderFoundCard(state);
  renderProgress(state);
  renderActions(state);
  renderQueueViewState(viewState);
  renderQueueList(state, viewState);
}

async function handleRetryFailed() {
  if (isRetrying) return;

  isRetrying = true;
  renderActions(getQueueState());
  try {
    const state = await window.electronAPI.retryFailedQueueJobs();
    renderQueueState(state);
    showToast('已將失敗項目移回待處理佇列', 'success');
  } catch (error) {
    showToast(`重試失敗項目時發生錯誤：${error.message}`, 'error');
  } finally {
    isRetrying = false;
    renderActions(getQueueState());
  }
}

async function handleClearFinished() {
  if (isClearing) return;

  isClearing = true;
  renderActions(getQueueState());
  try {
    const state = await window.electronAPI.clearFinishedQueueJobs();
    renderQueueState(state);
    showToast('已清除已完成項目', 'info');
  } catch (error) {
    showToast(`清除已完成項目時發生錯誤：${error.message}`, 'error');
  } finally {
    isClearing = false;
    renderActions(getQueueState());
  }
}

async function runJobAction(jobId, actionType, actionFn, successMessage) {
  if (isJobActionPending(jobId)) return;

  activeJobAction = { jobId, type: actionType };
  renderQueueState();

  try {
    const state = await actionFn();
    latestQueueState = state;
    renderQueueState(state, latestViewState);
    showToast(successMessage, 'success');
  } catch (error) {
    showToast(error.message || '佇列操作失敗', 'error');
  } finally {
    activeJobAction = null;
    renderQueueState(latestQueueState, latestViewState);
  }
}

function handleRetryJob(jobId) {
  return runJobAction(
    jobId,
    'retry',
    () => window.electronAPI.retryQueueJob(jobId),
    '已將項目重新加入待處理佇列',
  );
}

function handleRemoveJob(jobId) {
  return runJobAction(
    jobId,
    'remove',
    () => window.electronAPI.removeQueueJob(jobId),
    '已從佇列移除項目',
  );
}

function handleMoveJob(jobId, direction) {
  const directionLabel = direction === 'up' ? '上移' : '下移';
  return runJobAction(
    jobId,
    'move',
    () => window.electronAPI.moveQueueJob(jobId, direction),
    `已將項目${directionLabel}`,
  );
}

function bindActions() {
  if (actionsBound) return;
  actionsBound = true;

  retryFailedButton?.addEventListener('click', () => {
    handleRetryFailed();
  });

  clearFinishedButton?.addEventListener('click', () => {
    handleClearFinished();
  });

  queueSearchInput?.addEventListener('input', (event) => {
    setQueueSearchQuery(event.target.value);
  });

  queueFilterContainer?.querySelectorAll('.queue-filter-chip').forEach((button) => {
    button.addEventListener('click', () => {
      setQueueStatusFilter(button.dataset.filter || 'all');
    });
  });
}

function initQueuePanel() {
  bindActions();
  subscribeQueueState((state) => {
    latestQueueState = state;
    renderQueueState(state, latestViewState);
    // Mirror the currently-running job's stage into the top-right status
    // badge so it's always visible, even when the Batch Progress card is
    // scrolled off screen or obscured by other left-panel cards.
    const runningJob = state.currentJob;
    if (runningJob && (runningJob.status === 'running' || runningJob.status === 'paused')) {
      setStage(runningJob.stage || '');
    }
  });
  subscribeQueueViewState((viewState) => {
    latestViewState = viewState;
    renderQueueState(latestQueueState, viewState);
  });
  // Stage labels and job status pills are resolved at render time via
  // t(), so a language switch just needs one re-render to refresh.
  window.addEventListener('app:language-changed', () => {
    renderQueueState(latestQueueState, latestViewState);
  });
  renderQueueState(latestQueueState, latestViewState);
}

export {
  initQueuePanel,
};
