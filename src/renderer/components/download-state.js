'use strict';

/**
 * Renderer-side observer store for model download state.
 *
 * Mirrors the pattern of queue-state.js: subscribe / applyState / notify.
 * The main process broadcasts `downloads:state-updated` whenever the
 * download-state Map is mutated (new download, progress tick, completion,
 * cancellation); we apply it here and notify all subscribers so the
 * download-panel and titlebar-indicator components can re-render.
 */

const subscribers = new Set();
let initialized = false;

let state = normalizeState();

function normalizeState(raw) {
  const input = raw || {};
  const downloads = Array.isArray(input.downloads) ? input.downloads : [];
  const running = downloads.filter((d) => d.status === 'running');
  const completed = downloads.filter((d) => d.status === 'completed');
  const failed = downloads.filter((d) => d.status === 'failed' || d.status === 'interrupted');
  const cancelled = downloads.filter((d) => d.status === 'cancelled');
  return {
    downloads,
    current: running[0] || null,
    history: [...completed, ...failed, ...cancelled],
    stats: {
      total: downloads.length,
      running: running.length,
      completed: completed.length,
      failed: failed.length + cancelled.length,
    },
  };
}

function applyState(next) {
  state = normalizeState(next);
  for (const listener of subscribers) {
    try {
      listener(state);
    } catch (err) {
      console.error('[download-state] subscriber error:', err);
    }
  }
}

function subscribeDownloads(listener) {
  subscribers.add(listener);
  listener(state);
  return () => subscribers.delete(listener);
}

function getDownloadState() {
  return state;
}

async function initDownloadState() {
  if (initialized) return state;
  initialized = true;

  window.electronAPI.downloads.onStateUpdated((nextState) => {
    applyState(nextState);
  });

  try {
    const initial = await window.electronAPI.downloads.getState();
    applyState(initial);
  } catch (_) {
    // Main process may not have the handler registered yet on very
    // early boot; the first broadcast will fix it.
  }

  return state;
}

export {
  initDownloadState,
  subscribeDownloads,
  getDownloadState,
};
