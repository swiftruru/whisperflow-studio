'use strict';

import { getQueueState, subscribeQueueState } from './queue-state.js';
import { showToast } from './toast.js';

const foundCard = document.getElementById('found-card');
const foundFilename = document.getElementById('found-filename');
const foundFilepath = document.getElementById('found-filepath');
const missingCountBadge = document.getElementById('missing-count-badge');

const progressCard = document.getElementById('progress-card');
const progressHeadline = document.getElementById('queue-progress-headline');
const progressStats = document.getElementById('queue-progress-stats');
const progressCurrent = document.getElementById('queue-progress-current');
const progressStage = document.getElementById('queue-stage-chip');
const progressBarFill = document.getElementById('queue-progress-bar-fill');

const retryFailedButton = document.getElementById('btn-queue-retry-failed');
const clearFinishedButton = document.getElementById('btn-queue-clear-finished');

const queueCard = document.getElementById('queue-card');
const queueTotalBadge = document.getElementById('queue-total-badge');
const queueList = document.getElementById('queue-list');

let actionsBound = false;
let isRetrying = false;
let isClearing = false;

function stageLabel(stage) {
  switch (stage) {
    case 'scanning': return 'Scanning';
    case 'ready': return 'Ready';
    case 'running': return 'Running';
    case 'paused': return 'Paused';
    case 'completed': return 'Done';
    case 'error': return 'Error';
    case 'preparing': return 'Preparing';
    case 'transcribing': return 'Transcribing';
    case 'finalizing': return 'Finalizing';
    case 'failed': return 'Failed';
    case 'skipped': return 'Skipped';
    default: return 'Idle';
  }
}

function jobStatusLabel(status) {
  switch (status) {
    case 'pending': return 'Pending';
    case 'running': return 'Running';
    case 'paused': return 'Paused';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    case 'skipped': return 'Skipped';
    default: return status;
  }
}

function getJobStageLabel(job) {
  if (!job) return 'Idle';
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

function renderFoundCard(state) {
  const currentJob = state.currentJob;
  const remaining = state.stats.pending + state.stats.running + state.stats.paused + state.stats.failed;

  if (!currentJob) {
    foundCard.hidden = true;
    return;
  }

  foundFilename.textContent = currentJob.fileName;
  foundFilepath.textContent = currentJob.filePath;
  missingCountBadge.textContent = `剩餘 ${remaining} 個`;
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
  progressBarFill.style.width = `${getBatchProgressPercent(state).toFixed(1)}%`;

  if (state.stats.total === 0) {
    progressHeadline.textContent = 'No missing subtitles found';
    progressStats.textContent =
      `Scanned ${state.scanSummary.scannedFiles} files in ${state.scanSummary.scannedDirectories} folders`;
    progressCurrent.textContent = '目前沒有待處理的轉錄佇列';
    return;
  }

  if (state.currentJob) {
    const currentLabel = state.currentJob.status === 'pending'
      ? 'Next up'
      : getJobStageLabel(state.currentJob);
    progressHeadline.textContent = `${currentLabel} · ${state.currentJob.fileName}`;
  } else if (processedCount === state.stats.total) {
    progressHeadline.textContent = 'All queued files processed';
  } else {
    progressHeadline.textContent = 'Queue ready';
  }

  progressStats.textContent =
    `Pending ${state.stats.pending} · Running ${state.stats.running} · Paused ${state.stats.paused} · Done ${state.stats.done} · Skipped ${state.stats.skipped} · Failed ${state.stats.failed}`;

  const scanSummary = `Scanned ${state.scanSummary.scannedFiles} files in ${state.scanSummary.scannedDirectories} folders`;
  const completion = `${processedCount}/${state.stats.total} processed`;
  progressCurrent.textContent = state.currentJob
    ? `${completion} · ${scanSummary}`
    : `${completion} · ${scanSummary}`;
}

function renderActions(state) {
  const finishedCount = state.stats.done + state.stats.skipped;

  retryFailedButton.hidden = state.stats.failed === 0;
  retryFailedButton.disabled = isRetrying;

  clearFinishedButton.hidden = finishedCount === 0;
  clearFinishedButton.disabled = isClearing;
}

function renderQueueList(state) {
  if (state.stats.total === 0) {
    queueCard.hidden = true;
    queueList.innerHTML = '';
    return;
  }

  queueCard.hidden = false;
  queueTotalBadge.textContent = `${state.stats.total} files`;
  queueList.innerHTML = '';

  state.jobs.forEach((job, index) => {
    const row = document.createElement('div');
    row.className = `queue-item ${job.status}`;
    if (job.id === state.currentJobId) {
      row.classList.add('current');
    }

    const info = document.createElement('div');
    info.className = 'queue-item-info';

    const name = document.createElement('div');
    name.className = 'queue-item-name';
    name.textContent = `${index + 1}. ${job.fileName}`;

    const meta = document.createElement('div');
    meta.className = 'queue-item-meta';
    meta.textContent = `${getJobStageLabel(job)} · ${job.dirPath}`;

    info.appendChild(name);
    info.appendChild(meta);

    const status = document.createElement('span');
    status.className = `queue-item-status ${job.status}`;
    status.textContent = jobStatusLabel(job.status);

    row.appendChild(info);
    row.appendChild(status);

    if (job.error) {
      const error = document.createElement('div');
      error.className = 'queue-item-error';
      error.textContent = job.error;
      info.appendChild(error);
    }

    queueList.appendChild(row);
  });
}

function renderQueueState(state = getQueueState()) {
  renderFoundCard(state);
  renderProgress(state);
  renderActions(state);
  renderQueueList(state);
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

function bindActions() {
  if (actionsBound) return;
  actionsBound = true;

  retryFailedButton?.addEventListener('click', () => {
    handleRetryFailed();
  });

  clearFinishedButton?.addEventListener('click', () => {
    handleClearFinished();
  });
}

function initQueuePanel() {
  bindActions();
  subscribeQueueState(renderQueueState);
  renderQueueState();
}

export {
  initQueuePanel,
};
