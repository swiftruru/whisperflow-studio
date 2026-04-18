'use strict';

/**
 * Transcript preview card — shown on the Main tab right after a
 * transcription job finishes successfully.  Reads the segment JSON
 * (or falls back to SRT) via the `transcript:read` IPC and renders a
 * scrollable, searchable list of time-coded segments.
 *
 * Closed automatically when the next job in the batch starts, so the
 * card always reflects the most recently completed file.
 */

import { t, onLanguageChanged } from '../lib/i18n.js';
import { showToast } from './toast.js';

let initialized = false;
let currentSegments = [];
let currentSource = null;
let currentMediaPath = null;

const cardEl = () => document.getElementById('transcript-preview-card');
const filenameEl = () => document.getElementById('transcript-preview-filename');
const metaEl = () => document.getElementById('transcript-preview-meta');
const statusEl = () => document.getElementById('transcript-preview-status');
const segmentsEl = () => document.getElementById('transcript-preview-segments');
const searchEl = () => document.getElementById('transcript-preview-search');
const copyAllBtn = () => document.getElementById('btn-transcript-copy-all');
const revealBtn = () => document.getElementById('btn-transcript-reveal');
const closeBtn = () => document.getElementById('btn-transcript-close');

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
  const card = cardEl();
  if (card) card.hidden = true;
  currentSegments = [];
  currentSource = null;
  currentMediaPath = null;
  clearSegments();
  setStatus('');
}

async function openTranscriptPreview({ mediaPath, outputDir }) {
  const card = cardEl();
  if (!card) return;
  initTranscriptPreview();

  currentMediaPath = mediaPath || null;
  currentSegments = [];
  currentSource = null;

  card.hidden = false;
  filenameEl().textContent = basename(mediaPath);
  metaEl().textContent = '';
  clearSegments();
  setStatus(t('transcript:empty.loading'));

  try {
    const result = await window.electronAPI.transcript.read({ mediaPath, outputDir });
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
    setStatus(t('transcript:empty.loadFailed', { error: err?.message || String(err) }));
  }
}

function initTranscriptPreview() {
  if (initialized) return;
  if (!cardEl()) return;
  initialized = true;

  searchEl()?.addEventListener('input', (e) => {
    renderSegments(e.target.value);
  });

  copyAllBtn()?.addEventListener('click', copyAllSegments);
  revealBtn()?.addEventListener('click', revealInFolder);
  closeBtn()?.addEventListener('click', closePreview);

  onLanguageChanged(() => {
    if (!cardEl() || cardEl().hidden) return;
    renderMeta();
    renderSegments(searchEl()?.value || '');
  });
}

export { initTranscriptPreview, openTranscriptPreview, closePreview as closeTranscriptPreview };
