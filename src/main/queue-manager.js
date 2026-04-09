'use strict';

const fs = require('fs');
const path = require('path');
const { readConfig, writeConfig } = require('./config-manager');
const { readConfigMetadata } = require('./config-metadata');

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEmptyState() {
  return {
    rootPath: '',
    stage: 'idle',
    jobs: [],
    currentJobId: null,
    scanSummary: {
      scannedDirectories: 0,
      scannedFiles: 0,
    },
    lastFinishedJob: null,
    updatedAt: new Date().toISOString(),
  };
}

function naturalSortKey(value) {
  return String(value)
    .split(/(\d+)/)
    .filter(Boolean)
    .map((part) => (part.match(/^\d+$/) ? Number(part) : part.toLowerCase()));
}

function compareNatural(a, b) {
  const aKey = naturalSortKey(a);
  const bKey = naturalSortKey(b);
  const maxLength = Math.max(aKey.length, bKey.length);

  for (let index = 0; index < maxLength; index += 1) {
    const left = aKey[index];
    const right = bKey[index];

    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    if (typeof left === 'number' && typeof right === 'number') {
      return left - right;
    }

    return String(left).localeCompare(String(right));
  }

  return 0;
}

function hasSubtitleForMedia(fileName, siblingFiles, subtitleExtensions) {
  const baseName = path.parse(fileName).name.toLowerCase();
  return siblingFiles.some((candidate) => {
    const lower = candidate.toLowerCase();
    return lower.startsWith(baseName) && subtitleExtensions.some((ext) => lower.endsWith(ext));
  });
}

function computeStats(jobs = []) {
  return jobs.reduce((stats, job) => {
    stats.total += 1;
    stats[job.status] = (stats[job.status] || 0) + 1;
    return stats;
  }, {
    total: 0,
    pending: 0,
    running: 0,
    paused: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  });
}

function createQueueManager({
  configPath,
  configMetadataPath,
  onStateChange,
}) {
  const metadata = readConfigMetadata(configMetadataPath);
  const supportedMediaExtensions = new Set(
    (metadata.media?.supportedMediaExtensions || []).map((ext) => ext.toLowerCase())
  );
  const subtitleExtensions = (metadata.media?.subtitleExtensions || []).map((ext) => ext.toLowerCase());

  let nextJobId = 1;
  let state = createEmptyState();

  function getRunnableJob() {
    const runningJob = state.jobs.find((job) => job.status === 'running');
    if (runningJob) return runningJob;

    const currentJob = state.jobs.find((job) => job.id === state.currentJobId);
    if (currentJob && (currentJob.status === 'pending' || currentJob.status === 'failed')) {
      return currentJob;
    }

    return state.jobs.find((job) => job.status === 'pending')
      || state.jobs.find((job) => job.status === 'failed')
      || null;
  }

  function getCurrentJob() {
    return state.jobs.find((job) => job.status === 'running')
      || state.jobs.find((job) => job.status === 'paused')
      || state.jobs.find((job) => job.id === state.currentJobId)
      || getRunnableJob();
  }

  function buildSnapshot() {
    const currentJob = getCurrentJob();
    return cloneJson({
      ...state,
      currentJob,
      stats: computeStats(state.jobs),
      updatedAt: new Date().toISOString(),
    });
  }

  function emitState() {
    state.updatedAt = new Date().toISOString();
    onStateChange(buildSnapshot());
  }

  function syncActiveConfig() {
    const config = readConfig(configPath);
    config.SETTING = config.SETTING || {};

    const currentJob = getCurrentJob();
    const stats = computeStats(state.jobs);
    config.SETTING.media_root_path = state.rootPath || config.SETTING.media_root_path || '';
    config.SETTING.media_file_path = currentJob?.dirPath || '';
    config.SETTING.media_file_name = currentJob?.fileName || '';
    config.SETTING.missing_count = stats.pending + stats.running + stats.paused + stats.failed;

    writeConfig(configPath, config);
  }

  function setNextCurrentJob() {
    const nextJob = state.jobs.find((item) => item.status === 'running')
      || state.jobs.find((item) => item.status === 'paused')
      || state.jobs.find((item) => item.status === 'pending')
      || state.jobs.find((item) => item.status === 'failed')
      || null;

    state.currentJobId = nextJob?.id || null;
    return nextJob;
  }

  function scanMedia(rootPath) {
    state = {
      ...state,
      rootPath,
      stage: 'scanning',
      jobs: [],
      currentJobId: null,
      lastFinishedJob: null,
      scanSummary: {
        scannedDirectories: 0,
        scannedFiles: 0,
      },
    };
    emitState();

    const jobs = [];
    let scannedDirectories = 0;
    let scannedFiles = 0;
    const stack = [rootPath];

    while (stack.length > 0) {
      const currentDir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (_) {
        continue;
      }

      scannedDirectories += 1;
      const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      scannedFiles += fileNames.length;

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            stack.push(path.join(currentDir, entry.name));
          }
          continue;
        }

        if (!entry.isFile()) continue;

        const fileExt = path.extname(entry.name).toLowerCase();
        if (!supportedMediaExtensions.has(fileExt)) continue;
        if (hasSubtitleForMedia(entry.name, fileNames, subtitleExtensions)) continue;

        jobs.push({
          id: `job_${nextJobId++}`,
          fileName: entry.name,
          dirPath: currentDir,
          filePath: path.join(currentDir, entry.name),
          status: 'pending',
          stage: 'idle',
          progress: 0,
          error: null,
        });
      }
    }

    jobs.sort((left, right) => {
      const nameCompare = compareNatural(left.fileName, right.fileName);
      if (nameCompare !== 0) return nameCompare;
      return left.filePath.localeCompare(right.filePath);
    });

    state = {
      ...createEmptyState(),
      rootPath,
      stage: jobs.length > 0 ? 'ready' : 'idle',
      jobs,
      currentJobId: jobs[0]?.id || null,
      scanSummary: {
        scannedDirectories,
        scannedFiles,
      },
    };

    syncActiveConfig();
    emitState();
    return buildSnapshot();
  }

  function startNextJob() {
    if (state.jobs.some((item) => item.status === 'paused')) {
      return null;
    }

    const job = getRunnableJob();
    if (!job) return null;

    state.currentJobId = job.id;
    state.stage = 'running';
    state.lastFinishedJob = null;
    job.status = 'running';
    job.stage = 'preparing';
    job.progress = 5;
    job.error = null;

    syncActiveConfig();
    emitState();
    return cloneJson(job);
  }

  function updateRunningJobStage(stage, progress = null) {
    const job = state.jobs.find((item) => item.status === 'running' || item.status === 'paused');
    if (!job) return;

    job.stage = stage;
    if (typeof progress === 'number') {
      job.progress = progress;
    }
    emitState();
  }

  function pauseCurrentJob() {
    const job = state.jobs.find((item) => item.status === 'running');
    if (!job) return buildSnapshot();

    job.resumeStage = job.stage && job.stage !== 'idle' ? job.stage : 'transcribing';
    job.status = 'paused';
    job.stage = 'paused';
    state.currentJobId = job.id;
    state.stage = 'paused';

    syncActiveConfig();
    emitState();
    return buildSnapshot();
  }

  function resumeCurrentJob() {
    const job = state.jobs.find((item) => item.status === 'paused');
    if (!job) return buildSnapshot();

    job.status = 'running';
    job.stage = job.resumeStage || 'transcribing';
    delete job.resumeStage;
    state.currentJobId = job.id;
    state.stage = 'running';

    syncActiveConfig();
    emitState();
    return buildSnapshot();
  }

  function handleRunnerOutput(text) {
    const normalized = String(text || '').toLowerCase();

    if (normalized.includes('reading config.json')) {
      updateRunningJobStage('preparing', 10);
      return;
    }

    if (normalized.includes('starting cli transcription') || normalized.includes('starting transcription')) {
      updateRunningJobStage('preparing', 20);
      return;
    }

    if (normalized.includes('started at')) {
      updateRunningJobStage('transcribing', 45);
      return;
    }

    if (normalized.includes('finished at') || normalized.includes('duration:')) {
      updateRunningJobStage('finalizing', 90);
      return;
    }

    if (normalized.includes('subtitles generated')) {
      updateRunningJobStage('completed', 100);
    }
  }

  function finishCurrentJob(code, errorMessage = '') {
    const job = state.jobs.find((item) => item.status === 'running');
    if (!job) return buildSnapshot();

    const success = code === 0;
    job.status = success ? 'done' : 'failed';
    job.stage = success ? 'completed' : 'failed';
    job.progress = success ? 100 : 0;
    job.error = success ? null : (errorMessage || `Process exited with code ${code}`);

    state.lastFinishedJob = {
      id: job.id,
      fileName: job.fileName,
      filePath: job.filePath,
      dirPath: job.dirPath,
      success,
      code,
      error: job.error,
    };

    const nextJob = setNextCurrentJob();
    state.stage = nextJob ? 'ready' : (success ? 'completed' : 'error');

    syncActiveConfig();
    emitState();
    return buildSnapshot();
  }

  function stopCurrentJob() {
    const job = state.jobs.find((item) => item.status === 'running' || item.status === 'paused');
    if (!job) return buildSnapshot();

    delete job.resumeStage;
    job.status = 'failed';
    job.stage = 'failed';
    job.progress = 0;
    job.error = 'Stopped by user';

    state.lastFinishedJob = {
      id: job.id,
      fileName: job.fileName,
      filePath: job.filePath,
      dirPath: job.dirPath,
      success: false,
      code: -2,
      error: job.error,
    };

    const nextJob = setNextCurrentJob();
    state.stage = nextJob ? 'ready' : 'error';

    syncActiveConfig();
    emitState();
    return buildSnapshot();
  }

  function skipCurrentJob() {
    const job = state.jobs.find((item) => item.status === 'running' || item.status === 'paused');
    if (!job) return buildSnapshot();

    delete job.resumeStage;
    job.status = 'skipped';
    job.stage = 'skipped';
    job.progress = 0;
    job.error = null;

    state.lastFinishedJob = {
      id: job.id,
      fileName: job.fileName,
      filePath: job.filePath,
      dirPath: job.dirPath,
      success: false,
      code: -3,
      error: null,
      skipped: true,
    };

    const nextJob = setNextCurrentJob();
    state.stage = nextJob ? 'ready' : 'completed';

    syncActiveConfig();
    emitState();
    return buildSnapshot();
  }

  function retryFailedJobs() {
    let retriedCount = 0;

    state.jobs.forEach((job) => {
      if (job.status !== 'failed') return;
      retriedCount += 1;
      job.status = 'pending';
      job.stage = 'idle';
      job.progress = 0;
      job.error = null;
    });

    const nextJob = setNextCurrentJob();
    if (retriedCount > 0) {
      state.stage = nextJob ? 'ready' : 'idle';
      syncActiveConfig();
      emitState();
    }

    return buildSnapshot();
  }

  function clearFinishedJobs() {
    const currentActiveJobId = state.jobs.find((job) => job.status === 'running' || job.status === 'paused')?.id || null;
    state.jobs = state.jobs.filter((job) => job.status !== 'done' && job.status !== 'skipped');

    if (currentActiveJobId && state.jobs.some((job) => job.id === currentActiveJobId)) {
      state.currentJobId = currentActiveJobId;
    } else {
      setNextCurrentJob();
    }

    if (state.jobs.length === 0) {
      state.stage = 'idle';
      state.lastFinishedJob = null;
    } else if (state.jobs.some((job) => job.status === 'running')) {
      state.stage = 'running';
    } else if (state.jobs.some((job) => job.status === 'paused')) {
      state.stage = 'paused';
    } else {
      state.stage = 'ready';
    }

    syncActiveConfig();
    emitState();
    return buildSnapshot();
  }

  function getState() {
    return buildSnapshot();
  }

  return {
    clearFinishedJobs,
    finishCurrentJob,
    getState,
    handleRunnerOutput,
    pauseCurrentJob,
    retryFailedJobs,
    resumeCurrentJob,
    scanMedia,
    skipCurrentJob,
    startNextJob,
    stopCurrentJob,
  };
}

module.exports = {
  createQueueManager,
};
