'use strict';

/**
 * Titlebar download indicator — a tiny badge next to the language
 * toggle that appears when a model download is in progress.  Shows
 * the current percentage; click switches to the Models tab.
 */

import { subscribeDownloads } from './download-state.js';

const chip = document.getElementById('download-indicator');

function initDownloadIndicator() {
  if (!chip) return;

  chip.addEventListener('click', () => {
    const modelsTabBtn = document.querySelector('[data-tab="models"]');
    modelsTabBtn?.click();
  });

  subscribeDownloads((state) => {
    const dl = state.current;
    if (!dl) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    const total = dl.totalBytes || 0;
    const downloaded = dl.downloadedBytes || 0;
    const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
    chip.textContent = `${percent}%`;
    chip.title = `${dl.name} — ${percent}%`;
  });
}

export { initDownloadIndicator };
