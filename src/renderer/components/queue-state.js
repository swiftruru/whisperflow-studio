'use strict';

const subscribers = new Set();

let initialized = false;
let state = normalizeQueueState();

function normalizeQueueState(nextState = {}) {
  return {
    rootPath: nextState.rootPath || '',
    stage: nextState.stage || 'idle',
    jobs: Array.isArray(nextState.jobs) ? nextState.jobs : [],
    currentJobId: nextState.currentJobId || null,
    currentJob: nextState.currentJob || null,
    lastFinishedJob: nextState.lastFinishedJob || null,
    stats: {
      total: nextState.stats?.total || 0,
      pending: nextState.stats?.pending || 0,
      running: nextState.stats?.running || 0,
      paused: nextState.stats?.paused || 0,
      done: nextState.stats?.done || 0,
      failed: nextState.stats?.failed || 0,
      skipped: nextState.stats?.skipped || 0,
    },
    scanSummary: {
      scannedDirectories: nextState.scanSummary?.scannedDirectories || 0,
      scannedFiles: nextState.scanSummary?.scannedFiles || 0,
    },
    updatedAt: nextState.updatedAt || null,
  };
}

function applyQueueState(nextState) {
  state = normalizeQueueState(nextState);
  subscribers.forEach((listener) => listener(state));
}

async function initQueueState() {
  if (initialized) return state;
  initialized = true;

  window.electronAPI.onQueueStateUpdated((nextState) => {
    applyQueueState(nextState);
  });

  try {
    const initialState = await window.electronAPI.getQueueState();
    applyQueueState(initialState);
  } catch (_) {}

  return state;
}

function getQueueState() {
  return state;
}

function subscribeQueueState(listener) {
  subscribers.add(listener);
  listener(state);

  return () => {
    subscribers.delete(listener);
  };
}

export {
  getQueueState,
  initQueueState,
  subscribeQueueState,
};
