'use strict';

import { t } from '../lib/i18n.js';

const HISTORY_MAX = 10;

/**
 * Format "time ago" using i18n keys.  We deliberately don't use
 * `Intl.RelativeTimeFormat` here — its output varies per locale in
 * ways that conflict with the rest of the tight-vertical UI (the
 * English form is "5 minutes ago" which is wider than the Chinese
 * "5 分鐘前").  The i18n keys give us full control over abbreviations.
 */
function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return t('progress:history.justNow');
  const m = Math.floor(s / 60);
  if (m < 60) return t('progress:history.minutesAgo', { count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('progress:history.hoursAgo', { count: h });
  const d = Math.floor(h / 24);
  return t('progress:history.daysAgo', { count: d });
}

export async function addHistoryEntry({ fileName, filePath, success }) {
  const entries = await window.electronAPI.readHistory().catch(() => []);
  entries.unshift({ fileName, filePath, success, timestamp: new Date().toISOString() });
  if (entries.length > HISTORY_MAX) entries.length = HISTORY_MAX;
  await window.electronAPI.writeHistory(entries);
  _cachedEntries = entries;
  renderHistory(entries);
}

let _cachedEntries = [];

export async function initHistory() {
  _cachedEntries = await window.electronAPI.readHistory().catch(() => []);
  renderHistory(_cachedEntries);

  const clearBtn = document.getElementById('btn-clear-history');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      await window.electronAPI.writeHistory([]);
      _cachedEntries = [];
      renderHistory([]);
    });
  }

  // Re-render on language switch so the "time ago" labels update.
  window.addEventListener('app:language-changed', () => {
    renderHistory(_cachedEntries);
  });
}

function renderHistory(entries) {
  const section = document.getElementById('history-section');
  const list    = document.getElementById('history-list');
  if (!section || !list) return;

  if (!entries || entries.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.innerHTML = '';

  entries.forEach(entry => {
    const row = document.createElement('div');
    row.className = `history-row ${entry.success ? 'ok' : 'fail'}`;

    const icon = document.createElement('span');
    icon.className = 'history-icon';
    icon.textContent = entry.success ? '✓' : '✗';

    const info = document.createElement('div');
    info.className = 'history-info';

    const name = document.createElement('span');
    name.className = 'history-name';
    name.textContent = entry.fileName || t('progress:history.unknownFile');
    name.title = entry.filePath || '';

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = entry.timestamp ? timeAgo(entry.timestamp) : '';

    info.appendChild(name);
    info.appendChild(time);
    row.appendChild(icon);
    row.appendChild(info);
    list.appendChild(row);
  });
}
