'use strict';

function clampProgress(value, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, number));
}

function estimateEtaFromProgress(elapsedSeconds, progress) {
  const safeElapsed = Number(elapsedSeconds);
  const safeProgress = Number(progress);

  if (!Number.isFinite(safeElapsed) || safeElapsed < 0) return null;
  if (!Number.isFinite(safeProgress) || safeProgress <= 0 || safeProgress >= 100) return null;

  return Math.max(0, Math.round((safeElapsed * (100 - safeProgress)) / safeProgress));
}

function calculateElapsedSeconds(startedAt, finishedAt = null) {
  if (!startedAt) return null;

  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;

  const endMs = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(endMs)) return null;

  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function getReferenceJobDuration(job) {
  if (!job) return null;

  if (typeof job.elapsedSeconds === 'number' && job.elapsedSeconds > 0) {
    return job.elapsedSeconds;
  }

  if (typeof job.progress === 'number' && typeof job.elapsedSeconds === 'number') {
    return job.elapsedSeconds + (estimateEtaFromProgress(job.elapsedSeconds, job.progress) || 0);
  }

  return calculateElapsedSeconds(job.startedAt, job.finishedAt);
}

function sumBatchEtaSeconds(jobs = []) {
  const activeJob = jobs.find((job) => job.status === 'running' || job.status === 'paused') || null;
  const pendingJobs = jobs.filter((job) => job.status === 'pending' || job.status === 'failed');

  const completedDurations = jobs
    .filter((job) => job.status === 'done' || job.status === 'skipped' || job.status === 'failed')
    .map(getReferenceJobDuration)
    .filter((value) => Number.isFinite(value) && value > 0);

  let eta = 0;
  let hasEstimate = false;

  if (activeJob) {
    const activeEta = Number.isFinite(activeJob.etaSeconds)
      ? activeJob.etaSeconds
      : estimateEtaFromProgress(activeJob.elapsedSeconds, activeJob.progress);

    if (Number.isFinite(activeEta)) {
      eta += activeEta;
      hasEstimate = true;
    }
  }

  const averageCompletedDuration = completedDurations.length > 0
    ? (completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length)
    : null;

  const fallbackDuration = averageCompletedDuration
    || (activeJob ? getReferenceJobDuration(activeJob) : null);

  if (Number.isFinite(fallbackDuration) && pendingJobs.length > 0) {
    eta += Math.round(fallbackDuration * pendingJobs.length);
    hasEstimate = true;
  }

  return hasEstimate ? eta : null;
}

function computeBatchElapsedSeconds(jobs = []) {
  const startedTimes = jobs
    .map((job) => job.startedAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (startedTimes.length === 0) return null;

  const earliestStart = Math.min(...startedTimes);
  const activeJob = jobs.find((job) => job.status === 'running' || job.status === 'paused') || null;

  if (activeJob) {
    return Math.max(0, Math.round((Date.now() - earliestStart) / 1000));
  }

  const finishedTimes = jobs
    .map((job) => job.finishedAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (finishedTimes.length === 0) return null;

  return Math.max(0, Math.round((Math.max(...finishedTimes) - earliestStart) / 1000));
}

module.exports = {
  calculateElapsedSeconds,
  clampProgress,
  computeBatchElapsedSeconds,
  estimateEtaFromProgress,
  sumBatchEtaSeconds,
};
