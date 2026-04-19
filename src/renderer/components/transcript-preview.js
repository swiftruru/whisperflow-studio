'use strict';

/**
 * Transcript preview — full-screen modal that lets users browse the
 * segment-by-segment output of a completed transcription with search,
 * copy-per-segment, and reveal-in-folder.
 *
 * Opened from three places:
 *   1. The toast that appears after a job finishes (action button).
 *   2. The eye button on a row in the Recent Transcripts history.
 *   3. Auto-open when `localStorage['transcript.autoOpenOnComplete']`
 *      is 'true' and a job completes.
 *
 * Design intentionally stays open across queue events — the user can
 * read the finished file's transcript while the batch continues with
 * the next one.  Closed manually via Esc, backdrop click, or the ✕
 * / Close buttons.
 */

import { t, onLanguageChanged } from '../lib/i18n.js';
import { showToast } from './toast.js';
import { openSubtitleEditor } from './subtitle-editor.js';

let initialized = false;
let currentSegments = [];
let currentSource = null;
let currentMediaPath = null;
let currentOutputDir = null;

const modalEl = () => document.getElementById('transcript-modal');
const panelEl = () => modalEl()?.querySelector('.transcript-modal-panel');
const filenameEl = () => document.getElementById('transcript-modal-filename');
const metaEl = () => document.getElementById('transcript-modal-meta');
const statusEl = () => document.getElementById('transcript-modal-status');
const segmentsEl = () => document.getElementById('transcript-modal-segments');
const searchEl = () => document.getElementById('transcript-modal-search');
const copyAllBtn = () => document.getElementById('btn-transcript-modal-copy-all');
const revealBtn = () => document.getElementById('btn-transcript-modal-reveal');
const closeBtn = () => document.getElementById('btn-transcript-modal-close');
const doneBtn = () => document.getElementById('btn-transcript-modal-done');

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00.000';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const sInt = Math.floor(s);
  const ms = Math.round((s - sInt) * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return `${pad2(h)}:${pad2(m)}:${pad2(sInt)}.${pad3(ms)}`;
}

function formatDurationHuman(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad2 = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

function basename(p) {
  if (!p) return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function setStatus(message) {
  const el = statusEl();
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function clearSegments() {
  const el = segmentsEl();
  if (el) el.innerHTML = '';
}

function renderMeta() {
  const el = metaEl();
  if (!el) return;
  const count = currentSegments.length;
  const duration = count > 0 ? currentSegments[count - 1].end : 0;
  const parts = [
    t('transcript:stats.segments', { count }),
    t('transcript:stats.duration', { duration: formatDurationHuman(duration) }),
  ];
  if (currentSource) {
    parts.push(t('transcript:stats.source', { path: basename(currentSource) }));
  }
  el.textContent = parts.filter(Boolean).join('  ·  ');
}

function renderSegments(query = '') {
  const list = segmentsEl();
  if (!list) return;
  list.innerHTML = '';

  const needle = query.trim().toLowerCase();
  let matchCount = 0;

  for (const seg of currentSegments) {
    const text = seg.text || '';
    if (needle && !text.toLowerCase().includes(needle)) continue;
    matchCount += 1;

    const row = document.createElement('div');
    row.className = 'transcript-segment';

    const timeEl = document.createElement('span');
    timeEl.className = 'transcript-segment-time';
    timeEl.textContent = `${formatTime(seg.start)} → ${formatTime(seg.end)}`;
    row.appendChild(timeEl);

    const textEl = document.createElement('span');
    textEl.className = 'transcript-segment-text';
    if (needle) {
      // Simple highlight — split on the needle (case-insensitive) and
      // wrap matches in <mark>.  Uses textContent so no HTML injection.
      const lower = text.toLowerCase();
      let cursor = 0;
      let idx;
      while ((idx = lower.indexOf(needle, cursor)) !== -1) {
        if (idx > cursor) textEl.appendChild(document.createTextNode(text.slice(cursor, idx)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(idx, idx + needle.length);
        textEl.appendChild(mark);
        cursor = idx + needle.length;
      }
      if (cursor < text.length) textEl.appendChild(document.createTextNode(text.slice(cursor)));
    } else {
      textEl.textContent = text;
    }
    row.appendChild(textEl);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'transcript-segment-copy';
    copyBtn.textContent = t('transcript:actions.copySegment');
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        showToast(t('transcript:toast.copiedSegment'), 'success', 1500);
      } catch (err) {
        showToast(t('transcript:toast.copyFailed', { error: err?.message || String(err) }), 'error', 3000);
      }
    });
    row.appendChild(copyBtn);

    list.appendChild(row);
  }

  if (matchCount === 0 && needle) {
    setStatus(t('transcript:search.noMatch', { query }));
  } else {
    setStatus('');
  }
}

async function copyAllSegments() {
  if (currentSegments.length === 0) return;
  const text = currentSegments.map((s) => s.text).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast(t('transcript:toast.copiedAll'), 'success', 2000);
  } catch (err) {
    showToast(t('transcript:toast.copyFailed', { error: err?.message || String(err) }), 'error', 3000);
  }
}

function revealInFolder() {
  if (!currentSource) return;
  window.electronAPI.showInFolder(currentSource);
}

function closePreview() {
  const m = modalEl();
  if (m) m.hidden = true;
  currentSegments = [];
  currentSource = null;
  currentMediaPath = null;
  currentOutputDir = null;
  clearSegments();
  setStatus('');
  // Clear the search input so the next open doesn't inherit a stale filter.
  const search = searchEl();
  if (search) search.value = '';
}

async function openTranscriptPreview({ mediaPath, outputDir }) {
  initTranscriptPreview();
  const m = modalEl();
  if (!m) return;

  currentSegments = [];
  currentSource = null;
  currentMediaPath = mediaPath || null;
  currentOutputDir = outputDir || null;

  m.hidden = false;
  filenameEl().textContent = basename(mediaPath);
  metaEl().textContent = '';
  clearSegments();
  setStatus(t('transcript:empty.loading'));

  // Focus the search input once the modal is visible so ⌘F-like flow
  // works naturally (though users also find it via mouse).  Defer a
  // frame so the browser has time to apply the `hidden` removal.
  requestAnimationFrame(() => {
    const search = searchEl();
    if (search) search.focus();
  });

  try {
    const result = await window.electronAPI.transcript.read({ mediaPath, outputDir });

    // Main returns a structured `{ ok, segments | errorCode, message }`
    // so we can show a friendly localized message instead of the raw
    // "Error invoking remote method …" string on the common "file was
    // deleted behind my back" case.
    if (result && result.ok === false) {
      if (result.errorCode === 'TRANSCRIPT_NOT_FOUND') {
        setStatus(t('transcript:empty.notFound'));
      } else {
        setStatus(t('transcript:empty.loadFailed', {
          error: result.message || t('transcript:empty.genericError'),
        }));
      }
      metaEl().textContent = '';
      return;
    }

    currentSegments = Array.isArray(result?.segments) ? result.segments : [];
    currentSource = result?.source || null;
    if (currentSegments.length === 0) {
      setStatus(t('transcript:empty.noFile'));
      metaEl().textContent = '';
      return;
    }
    renderMeta();
    renderSegments(searchEl()?.value || '');
    setStatus('');
  } catch (err) {
    // Only reached if IPC itself crashes (preload missing, main
    // process gone).  Not the "file deleted" case — that's handled
    // above as a structured result.
    setStatus(t('transcript:empty.loadFailed', {
      error: err?.message || t('transcript:empty.genericError'),
    }));
  }
}

function initTranscriptPreview() {
  if (initialized) return;
  if (!modalEl()) return;
  initialized = true;

  searchEl()?.addEventListener('input', (e) => {
    renderSegments(e.target.value);
  });

  copyAllBtn()?.addEventListener('click', copyAllSegments);
  revealBtn()?.addEventListener('click', revealInFolder);
  closeBtn()?.addEventListener('click', closePreview);
  doneBtn()?.addEventListener('click', closePreview);

  const editBtn = document.getElementById('btn-transcript-modal-edit');
  editBtn?.addEventListener('click', () => {
    if (!currentMediaPath) return;
    const media = currentMediaPath;
    const out = currentOutputDir;
    closePreview();
    openSubtitleEditor({ mediaPath: media, outputDir: out });
  });

  // No backdrop-click-to-close — users asked to avoid accidental
  // dismissals when the mouse slips off the edge of the panel.
  // Close is only via the ✕ button, the Close Preview button, or Esc.

  // Esc closes — only when the modal is visible, so we don't fight
  // other Esc handlers elsewhere in the app.
  document.addEventListener('keydown', (event) => {
    const m = modalEl();
    if (!m || m.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closePreview();
    } else if (event.key === '/' && document.activeElement !== searchEl()) {
      // Quick-focus search with "/" similar to a lot of dev tools.
      event.preventDefault();
      searchEl()?.focus();
    }
  });

  onLanguageChanged(() => {
    const m = modalEl();
    if (!m || m.hidden) return;
    renderMeta();
    renderSegments(searchEl()?.value || '');
  });
}

// ── Auto-open preference (Settings → Transcript preview card) ────────
// Stored in localStorage as 'transcript.autoOpenOnComplete' = 'true' | 'false'.
// Read synchronously from controls-bar when a job finishes.
const AUTO_OPEN_KEY = 'transcript.autoOpenOnComplete';

function getAutoOpenPref() {
  try { return localStorage.getItem(AUTO_OPEN_KEY) === 'true'; } catch (_) { return false; }
}

function setAutoOpenPref(value) {
  try { localStorage.setItem(AUTO_OPEN_KEY, value ? 'true' : 'false'); } catch (_) {}
}

function initTranscriptAutoOpenToggle() {
  const toggle = document.getElementById('pref-transcript-auto-open');
  if (!toggle) return;
  toggle.checked = getAutoOpenPref();
  toggle.addEventListener('change', () => setAutoOpenPref(toggle.checked));
}

export {
  initTranscriptPreview,
  openTranscriptPreview,
  closePreview as closeTranscriptPreview,
  initTranscriptAutoOpenToggle,
  getAutoOpenPref,
};
