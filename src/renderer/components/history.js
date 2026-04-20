'use strict';

import { t } from '../lib/i18n.js';
import { openTranscriptPreview } from './transcript-preview.js';
import { openSubtitleEditor } from './subtitle-editor.js';
import { showToast } from './toast.js';

const HISTORY_MAX = 10;

// Shared prune helper: asks the main process to filter out entries
// whose media file AND subtitle output are both gone. Persists the
// pruned list when anything was removed, so the next `readHistory()`
// reflects the cleanup. Returns { entries, removed } for callers that
// want to show feedback (manual refresh) or silently apply it (boot /
// auto on new entry).
async function pruneStaleEntries(entries) {
  if (!entries || entries.length === 0) return { entries: entries || [], removed: 0 };
  let outputDir = '';
  try {
    const cfg = await window.electronAPI.readConfig();
    outputDir = cfg?.SETTING?.output_dir || '';
  } catch (_) { /* best-effort */ }
  const kept = await window.electronAPI.pruneStaleHistory(entries, outputDir);
  const removed = entries.length - kept.length;
  if (removed > 0) {
    await window.electronAPI.writeHistory(kept);
  }
  return { entries: kept, removed };
}

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
  // Also sweep stale entries on every new addition — the new row
  // replaces the oldest when at cap, but if some middle rows have
  // decayed (files deleted) we want them gone too.
  const { entries: pruned } = await pruneStaleEntries(entries);
  _cachedEntries = pruned;
  renderHistory(pruned);
}

let _cachedEntries = [];

export async function initHistory() {
  const raw = await window.electronAPI.readHistory().catch(() => []);
  // Prune once at boot so the user never sees a row whose files are
  // gone — mirrors the recent-directories dropdown's startup prune.
  const { entries } = await pruneStaleEntries(raw);
  _cachedEntries = entries;
  renderHistory(entries);

  const clearBtn = document.getElementById('btn-clear-history');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      await window.electronAPI.writeHistory([]);
      _cachedEntries = [];
      renderHistory([]);
    });
  }

  const refreshBtn = document.getElementById('btn-refresh-history');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const { entries: kept, removed } = await pruneStaleEntries(_cachedEntries);
      _cachedEntries = kept;
      renderHistory(kept);
      if (removed > 0) {
        showToast(t('progress:history.prunedToast', { count: removed }), 'success');
      } else {
        showToast(t('progress:history.allValidToast'), 'info');
      }
    });
  }

  // Re-render on language switch so the "time ago" labels update.
  window.addEventListener('app:language-changed', () => {
    renderHistory(_cachedEntries);
  });
}

const EYE_SVG_MARKUP = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
`;

const FOLDER_SVG_MARKUP = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
  </svg>
`;

const PENCIL_SVG_MARKUP = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 20h9"/>
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
  </svg>
`;

async function renderHistory(entries) {
  const section = document.getElementById('history-section');
  const list    = document.getElementById('history-list');
  if (!section || !list) return;

  if (!entries || entries.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.innerHTML = '';

  // Resolve output_dir once — all transcript existence checks use it.
  let outputDir = '';
  try {
    const cfg = await window.electronAPI.readConfig();
    outputDir = cfg?.SETTING?.output_dir || '';
  } catch (_) { /* best-effort */ }

  // Pre-check which rows still have a transcript on disk, in parallel,
  // so we can decide whether to render each preview button.  If the
  // user manually deleted the .srt / .json, we skip the eye icon
  // instead of showing it and then popping an error modal on click.
  const existenceChecks = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.filePath || !entry.success) return false;
      try {
        return await window.electronAPI.transcript.exists({
          mediaPath: entry.filePath,
          outputDir,
        });
      } catch (_) {
        return false;
      }
    }),
  );

  entries.forEach((entry, idx) => {
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

    // Preview button — only when the row succeeded AND the transcript
    // file is still on disk.  Skipping the button when the file is
    // gone is better UX than popping a "file not found" modal.
    if (entry.filePath && entry.success && existenceChecks[idx]) {
      const previewBtn = document.createElement('button');
      previewBtn.className = 'history-action-btn history-action-preview';
      previewBtn.type = 'button';
      previewBtn.title = t('transcript:actions.preview');
      previewBtn.innerHTML = EYE_SVG_MARKUP;
      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTranscriptPreview({ mediaPath: entry.filePath, outputDir });
      });
      row.appendChild(previewBtn);

      const editBtn = document.createElement('button');
      editBtn.className = 'history-action-btn history-action-edit';
      editBtn.type = 'button';
      editBtn.title = t('transcript:actions.edit');
      editBtn.innerHTML = PENCIL_SVG_MARKUP;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSubtitleEditor({ mediaPath: entry.filePath, outputDir });
      });
      row.appendChild(editBtn);
    }

    if (entry.filePath) {
      const folderBtn = document.createElement('button');
      folderBtn.className = 'history-action-btn history-action-folder';
      folderBtn.type = 'button';
      folderBtn.title = t('queue:actions.showInFolder');
      folderBtn.innerHTML = FOLDER_SVG_MARKUP;
      folderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.electronAPI.showInFolder(entry.filePath);
      });
      row.appendChild(folderBtn);
    }

    list.appendChild(row);
  });
}
