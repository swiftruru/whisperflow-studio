'use strict';

/**
 * In-app subtitle editor.
 *
 * Scope intentionally narrow:
 *   - Only the segment `text` is editable.  Timestamps are read-only
 *     because an accidental drag on a number input is costly —
 *     mis-timed subtitles are much harder to notice than typos.
 *   - Source file can be any of json / srt / vtt (the transcript
 *     reader auto-picks the richest available); on save we regenerate
 *     every subtitle file whose `write_*` flag is currently enabled
 *     in Settings, so we mirror exactly what the Python transcriber
 *     would have written.
 *   - Original files are backed up to the OS tmp dir before being
 *     overwritten — never beside the media (keeps user folders clean).
 */

import { t, onLanguageChanged } from '../lib/i18n.js';
import { showToast } from './toast.js';
import { confirmDialog } from '../lib/confirm-dialog.js';

let initialized = false;
let state = {
  mediaPath: null,
  outputDir: null,
  sourceFormat: null,
  original: [],
  draft: [],
  dirty: false,
  saving: false,
  // Undo / redo history.  Each entry is a plain array of segment
  // `text` strings — timestamps are not user-editable, so a text-only
  // snapshot is enough to round-trip.  `historyIndex` is the currently
  // displayed snapshot; `savedIndex` tracks the one that matches disk
  // (so dirty = historyIndex !== savedIndex, and saving a file doesn't
  // erase history — the user can keep undoing back beyond the save).
  history: [],
  historyIndex: -1,
  savedIndex: -1,
};

// Debounced history commit timer for textarea typing.
let historyDebounce = null;
const HISTORY_COMMIT_DELAY_MS = 500;
const HISTORY_MAX = 200;

// Use `aria-disabled` instead of the native `disabled` attribute on
// all editor buttons.  Background: macOS Chromium/Electron maps the
// HTML `disabled` property onto NSControl.isEnabled=NO, which forces
// the system "not-allowed" cursor regardless of our `cursor: url(...)`
// CSS (it's a platform-level override we can't defeat from userland
// stylesheets).  Using aria-disabled keeps the native state enabled
// so our themed cursor is respected, while still communicating the
// disabled state to assistive tech and styling it via CSS attribute
// selectors.  Click handlers have to manually bail when aria-disabled
// is true — we wrap that in setEnabled() / isEnabled() helpers below.
function setEnabled(el, enabled) {
  if (!el) return;
  if (enabled) {
    el.removeAttribute('aria-disabled');
    el.removeAttribute('tabindex');
  } else {
    el.setAttribute('aria-disabled', 'true');
    // Keep disabled buttons out of the keyboard Tab cycle so Tab
    // still skips them the way it would with native :disabled.
    el.setAttribute('tabindex', '-1');
  }
}
function isEnabled(el) {
  return !!el && el.getAttribute('aria-disabled') !== 'true';
}

const modalEl       = () => document.getElementById('subtitle-editor-modal');
const tbodyEl       = () => document.getElementById('subtitle-editor-tbody');
const filenameEl    = () => document.getElementById('subtitle-editor-filename');
const metaEl        = () => document.getElementById('subtitle-editor-meta');
const saveBtn       = () => document.getElementById('btn-subtitle-editor-save');
const revertBtn     = () => document.getElementById('btn-subtitle-editor-revert');
const cancelBtn     = () => document.getElementById('btn-subtitle-editor-cancel');
const closeBtn      = () => document.getElementById('btn-subtitle-editor-close');
const dirtyFlagEl   = () => document.getElementById('subtitle-editor-dirty');

// ── Find & replace ─────────────────────────────────────────────────
const findbarEl     = () => document.getElementById('subtitle-editor-findbar');
const findToggleBtn = () => document.getElementById('btn-subtitle-editor-find-toggle');
const findInputEl   = () => document.getElementById('subtitle-editor-find-input');
const replaceInputEl= () => document.getElementById('subtitle-editor-replace-input');
const findCountEl   = () => document.getElementById('subtitle-editor-find-count');
const findPrevBtn   = () => document.getElementById('btn-subtitle-editor-find-prev');
const findNextBtn   = () => document.getElementById('btn-subtitle-editor-find-next');
const findCaseEl    = () => document.getElementById('subtitle-editor-find-case');
const replaceOneBtn = () => document.getElementById('btn-subtitle-editor-replace-one');
const replaceAllBtn = () => document.getElementById('btn-subtitle-editor-replace-all');

// ── Undo / Redo ────────────────────────────────────────────────────
const undoBtn       = () => document.getElementById('btn-subtitle-editor-undo');
const redoBtn       = () => document.getElementById('btn-subtitle-editor-redo');

let findState = { matches: [], cursor: -1 };

function basename(p) {
  if (!p) return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function formatTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}.${pad3(ms)}`;
}

function segmentsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if ((a[i]?.text ?? '') !== (b[i]?.text ?? '')) return false;
  }
  return true;
}

// ── Undo / Redo history ─────────────────────────────────────────
function currentTextSnapshot() {
  return state.draft.map((s) => s.text || '');
}

function snapshotsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function commitHistoryNow() {
  if (historyDebounce) { clearTimeout(historyDebounce); historyDebounce = null; }
  const snap = currentTextSnapshot();
  const top = state.history[state.historyIndex];
  if (snapshotsEqual(top, snap)) return;
  // Dropping any redo tail — once the user branches, the old future is gone.
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snap);
  if (state.history.length > HISTORY_MAX) {
    const overflow = state.history.length - HISTORY_MAX;
    state.history.splice(0, overflow);
    state.savedIndex = Math.max(-1, state.savedIndex - overflow);
  }
  state.historyIndex = state.history.length - 1;
  updateUndoRedoButtons();
}

function scheduleHistoryCommit() {
  if (historyDebounce) clearTimeout(historyDebounce);
  historyDebounce = setTimeout(() => {
    historyDebounce = null;
    commitHistoryNow();
    syncDirtyFromHistory();
  }, HISTORY_COMMIT_DELAY_MS);
}

function resetHistory() {
  if (historyDebounce) { clearTimeout(historyDebounce); historyDebounce = null; }
  state.history = [currentTextSnapshot()];
  state.historyIndex = 0;
  state.savedIndex = 0;
  updateUndoRedoButtons();
}

function applySnapshot(snap) {
  snap.forEach((text, i) => {
    if (state.draft[i]) state.draft[i].text = text;
  });
  renderRows();
  syncDirtyFromHistory();
  updateUndoRedoButtons();
  if (findbarEl() && !findbarEl().hidden) computeMatches();
}

function undo() {
  commitHistoryNow();
  if (state.historyIndex <= 0) return;
  state.historyIndex -= 1;
  applySnapshot(state.history[state.historyIndex]);
}

function redo() {
  commitHistoryNow();
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex += 1;
  applySnapshot(state.history[state.historyIndex]);
}

function updateUndoRedoButtons() {
  setEnabled(undoBtn(), !state.saving && state.historyIndex > 0);
  setEnabled(redoBtn(), !state.saving && state.historyIndex < state.history.length - 1);
}

// Dirty flag is derived from history after an undo/redo or commit:
// draft matches the saved snapshot → clean.  Otherwise → dirty.
function syncDirtyFromHistory() {
  const saved = state.history[state.savedIndex];
  const curr  = currentTextSnapshot();
  const clean = snapshotsEqual(saved, curr);
  if (clean) {
    state.dirty = false;
    const flag = dirtyFlagEl();
    if (flag) flag.hidden = true;
  } else {
    state.dirty = true;
    const flag = dirtyFlagEl();
    if (flag) {
      flag.textContent = t('transcript:editor.hints.unsaved');
      flag.hidden = false;
    }
  }
  updateButtons();
}

/**
 * Two independent flags drive the footer buttons:
 *   - `dirty` (draft ≠ last saved)  → save button.  Reset after a
 *     successful save so the user can't spam identical writes.
 *   - `canRevert` (draft ≠ session-start original) → revert button.
 *     `state.original` is never mutated mid-session, so this stays
 *     "undo everything back to when I opened the editor" even
 *     across multiple saves within the session.
 */
function markDirty() {
  state.dirty = true;
  const flag = dirtyFlagEl();
  if (flag) {
    flag.textContent = t('transcript:editor.hints.unsaved');
    flag.hidden = false;
  }
  updateButtons();
}

function clearDirty() {
  state.dirty = false;
  const flag = dirtyFlagEl();
  if (flag) flag.hidden = true;
  updateButtons();
}

function updateButtons() {
  const btn = saveBtn();
  if (btn) {
    setEnabled(btn, !state.saving && state.dirty);
    btn.textContent = state.saving
      ? t('transcript:editor.actions.saving')
      : t('transcript:editor.actions.save');
  }
  const revert = revertBtn();
  if (revert) {
    const canRevert = !state.saving && !segmentsEqual(state.draft, state.original);
    setEnabled(revert, canRevert);
  }
  updateUndoRedoButtons();
}

// Back-compat alias — a few call sites still read this name.
const updateSaveButton = updateButtons;

function autosizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function renderRows() {
  const tbody = tbodyEl();
  if (!tbody) return;
  tbody.innerHTML = '';

  state.draft.forEach((seg, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'subtitle-editor-row';
    tr.dataset.index = String(idx);

    const idxTd = document.createElement('td');
    idxTd.className = 'subtitle-editor-cell-index';
    idxTd.textContent = String(idx + 1);
    tr.appendChild(idxTd);

    const timeTd = document.createElement('td');
    timeTd.className = 'subtitle-editor-cell-time';
    timeTd.textContent = `${formatTime(seg.start)}  →  ${formatTime(seg.end)}`;
    tr.appendChild(timeTd);

    const textTd = document.createElement('td');
    const textArea = document.createElement('textarea');
    textArea.className = 'subtitle-editor-text-input';
    textArea.rows = Math.max(1, String(seg.text || '').split('\n').length);
    textArea.value = seg.text || '';
    textArea.spellcheck = false;
    // Subtitle segments are single-line in this editor.  Block the
    // Enter key from inserting a literal newline — but defer to the
    // IME (注音/Pinyin/Kana) when it's using Enter to commit a
    // candidate, otherwise typing Chinese becomes impossible.
    textArea.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
    });
    textArea.addEventListener('input', () => {
      // Safety net for pasted multi-line content — collapse any
      // newlines into a single space so downstream writers never
      // produce multi-line segments.
      if (textArea.value.includes('\n')) {
        const cleaned = textArea.value.replace(/\s*\n+\s*/g, ' ');
        textArea.value = cleaned;
      }
      state.draft[idx].text = textArea.value;
      autosizeTextarea(textArea);
      markDirty();
      scheduleHistoryCommit();
      if (findbarEl() && !findbarEl().hidden) computeMatches();
    });
    // When the user tabs or clicks away from a textarea, flush any
    // pending typing into the history right away.  Otherwise a blur
    // followed by an immediate Cmd+Z would undo past the in-progress
    // edit instead of the one just finished.
    textArea.addEventListener('blur', () => {
      if (historyDebounce) { commitHistoryNow(); syncDirtyFromHistory(); }
    });
    textTd.appendChild(textArea);
    tr.appendChild(textTd);

    tbody.appendChild(tr);
    requestAnimationFrame(() => autosizeTextarea(textArea));
  });

  updateSaveButton();
  if (findbarEl() && !findbarEl().hidden) computeMatches();
}

function renderMeta(formats) {
  const el = metaEl();
  if (!el) return;
  const count = state.draft.length;
  const activeFormats = Object.entries(formats || {})
    .filter(([, on]) => on)
    .map(([k]) => k.toUpperCase())
    .join(' / ');
  const parts = [
    t('transcript:stats.segments', { count }),
    activeFormats ? t('transcript:editor.meta.targets', { formats: activeFormats }) : '',
  ].filter(Boolean);
  el.textContent = parts.join('  ·  ');
}

function truthy(v) {
  if (v === true) return true;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return !!v;
}

async function readEnabledFormats() {
  try {
    const cfg = await window.electronAPI.readConfig();
    const s = cfg?.SETTING || {};
    return {
      srt:  truthy(s.write_srt),
      vtt:  truthy(s.write_vtt),
      txt:  truthy(s.write_txt),
      json: truthy(s.write_json),
    };
  } catch (_) {
    return { srt: true, vtt: false, txt: false, json: false };
  }
}

async function handleSave() {
  if (state.saving || !state.dirty) return;
  state.saving = true;
  updateSaveButton();
  try {
    const formats = await readEnabledFormats();
    const anyEnabled = Object.values(formats).some(Boolean);
    if (!anyEnabled) {
      showToast(t('transcript:editor.toast.noFormatsEnabled'), 'warning', 4000);
      return;
    }
    const segments = state.draft.map((s) => ({
      start: Number(s.start) || 0,
      end:   Number(s.end) || 0,
      text:  String(s.text ?? ''),
    }));
    const result = await window.electronAPI.transcript.save({
      mediaPath: state.mediaPath,
      outputDir: state.outputDir,
      segments,
      formats,
    });
    if (!result || result.ok === false) {
      const msg = result?.message || t('transcript:empty.genericError');
      showToast(t('transcript:editor.toast.saveFailed', { error: msg }), 'error', 4500);
      return;
    }
    // Intentionally do NOT sync state.original here: revert should
    // keep undoing back to the text that was on disk when the user
    // opened this editor session, not to the most recent save.
    // Make sure any in-flight typing is in history before we mark
    // this index as the saved one, otherwise dirty would stay true.
    commitHistoryNow();
    state.savedIndex = state.historyIndex;
    syncDirtyFromHistory();
    const writtenExts = (result.written || [])
      .map((f) => (f.split('.').pop() || '').toUpperCase())
      .filter(Boolean);
    const skippedExts = (result.skipped || [])
      .map((f) => (f.split('.').pop() || '').toUpperCase())
      .filter(Boolean);
    const parts = [writtenExts.length
      ? t('transcript:editor.toast.saved', { formats: writtenExts.join(' / '), count: writtenExts.length })
      : t('transcript:editor.toast.savedNone')];
    if (skippedExts.length) {
      parts.push(t('transcript:editor.toast.skipped', { formats: skippedExts.join(' / ') }));
    }
    showToast(parts.join('  ·  '), writtenExts.length ? 'success' : 'info', 3000);
  } finally {
    state.saving = false;
    updateSaveButton();
  }
}

async function handleRevert() {
  if (!state.original.length) return;
  if (segmentsEqual(state.draft, state.original)) return;
  const ok = await confirmDialog({
    title: t('transcript:editor.confirm.revertTitle'),
    message: t('transcript:editor.confirm.revert'),
    confirmText: t('transcript:editor.actions.revert'),
    cancelText: t('transcript:editor.actions.cancel'),
    destructive: true,
  });
  if (!ok) return;
  state.draft = state.original.map((s) => ({ ...s }));
  // Push the reverted state onto history so Cmd+Z can bring back the
  // pre-revert edits if the user changes their mind.
  commitHistoryNow();
  syncDirtyFromHistory();
  renderRows();
  showToast(t('transcript:editor.toast.reverted'), 'info', 1500);
}

async function handleClose() {
  if (state.dirty) {
    const ok = await confirmDialog({
      title: t('transcript:editor.confirm.discardTitle'),
      message: t('transcript:editor.confirm.discard'),
      confirmText: t('transcript:editor.confirm.discardConfirm'),
      cancelText: t('transcript:editor.actions.cancel'),
      destructive: true,
    });
    if (!ok) return;
  }
  const m = modalEl();
  if (m) m.hidden = true;
  if (historyDebounce) { clearTimeout(historyDebounce); historyDebounce = null; }
  state = {
    mediaPath: null, outputDir: null, sourceFormat: null,
    original: [], draft: [], dirty: false, saving: false,
    history: [], historyIndex: -1, savedIndex: -1,
  };
  const tbody = tbodyEl();
  if (tbody) tbody.innerHTML = '';
  clearDirty();
  updateUndoRedoButtons();
  closeFindBar();
}

// ── Find & replace ───────────────────────────────────────────────
// Simple literal-string search across all segment text.  Matches
// are (segIdx, start, end) triples into `state.draft[i].text`.
// Non-overlapping, left-to-right, case-insensitive by default.
function computeMatches() {
  const needle = findInputEl()?.value || '';
  const caseSensitive = !!findCaseEl()?.checked;
  findState.matches = [];
  if (!needle) {
    findState.cursor = -1;
    updateFindUi();
    return;
  }
  const cmpNeedle = caseSensitive ? needle : needle.toLowerCase();
  for (let i = 0; i < state.draft.length; i += 1) {
    const haystack = state.draft[i].text || '';
    const cmpHay = caseSensitive ? haystack : haystack.toLowerCase();
    let from = 0;
    while (true) {
      const idx = cmpHay.indexOf(cmpNeedle, from);
      if (idx === -1) break;
      findState.matches.push({ segIdx: i, start: idx, end: idx + needle.length });
      from = idx + Math.max(1, needle.length);
    }
  }
  if (findState.matches.length === 0) findState.cursor = -1;
  else if (findState.cursor >= findState.matches.length || findState.cursor < 0) findState.cursor = 0;
  updateFindUi();
}

function updateFindUi() {
  const count = findCountEl();
  if (count) {
    const n = findState.matches.length;
    const i = findState.cursor >= 0 ? findState.cursor + 1 : 0;
    count.textContent = `${i} / ${n}`;
  }
  const hasMatch = findState.matches.length > 0 && findState.cursor >= 0;
  setEnabled(findPrevBtn(), hasMatch);
  setEnabled(findNextBtn(), hasMatch);
  setEnabled(replaceOneBtn(), hasMatch);
  setEnabled(replaceAllBtn(), findState.matches.length > 0);
}

function focusCurrentMatch() {
  if (findState.cursor < 0) return;
  const m = findState.matches[findState.cursor];
  if (!m) return;
  const row = tbodyEl()?.querySelector(`tr[data-index="${m.segIdx}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const ta = row.querySelector('textarea');
  if (ta) {
    ta.focus({ preventScroll: true });
    try { ta.setSelectionRange(m.start, m.end); } catch (_) { /* ignore */ }
  }
}

function stepMatch(delta) {
  if (findState.matches.length === 0) return;
  findState.cursor = (findState.cursor + delta + findState.matches.length) % findState.matches.length;
  updateFindUi();
  focusCurrentMatch();
}

function replaceCurrent() {
  if (findState.cursor < 0) return;
  const m = findState.matches[findState.cursor];
  if (!m) return;
  const replacement = replaceInputEl()?.value ?? '';
  const seg = state.draft[m.segIdx];
  seg.text = seg.text.slice(0, m.start) + replacement + seg.text.slice(m.end);
  // Reflect in the textarea without re-rendering the whole table
  // so the user's scroll position stays put.
  const row = tbodyEl()?.querySelector(`tr[data-index="${m.segIdx}"]`);
  const ta = row?.querySelector('textarea');
  if (ta) {
    ta.value = seg.text;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }
  markDirty();
  commitHistoryNow();
  // After a replace, matches may have shifted — recompute, keeping
  // cursor on the same logical position (which is now the next match).
  computeMatches();
  if (findState.matches.length > 0) {
    findState.cursor = Math.min(findState.cursor, findState.matches.length - 1);
    updateFindUi();
    focusCurrentMatch();
  }
}

function replaceAll() {
  const needle = findInputEl()?.value || '';
  if (!needle) return;
  const replacement = replaceInputEl()?.value ?? '';
  const caseSensitive = !!findCaseEl()?.checked;
  let count = 0;
  for (let i = 0; i < state.draft.length; i += 1) {
    const text = state.draft[i].text || '';
    let result = '';
    let from = 0;
    const cmpText = caseSensitive ? text : text.toLowerCase();
    const cmpNeedle = caseSensitive ? needle : needle.toLowerCase();
    while (true) {
      const idx = cmpText.indexOf(cmpNeedle, from);
      if (idx === -1) { result += text.slice(from); break; }
      result += text.slice(from, idx) + replacement;
      from = idx + needle.length;
      count += 1;
    }
    if (count > 0 && result !== text) {
      state.draft[i].text = result;
    }
  }
  if (count > 0) {
    markDirty();
    commitHistoryNow();
    renderRows();
    showToast(t('transcript:editor.find.replacedCount', { count }), 'success', 2000);
  } else {
    showToast(t('transcript:editor.find.noMatches'), 'info', 1500);
  }
  computeMatches();
}

function openFindBar() {
  const bar = findbarEl();
  if (!bar) return;
  bar.hidden = false;
  findInputEl()?.focus();
  findInputEl()?.select();
  computeMatches();
}

function closeFindBar() {
  const bar = findbarEl();
  if (bar) bar.hidden = true;
  findState = { matches: [], cursor: -1 };
  updateFindUi();
}

function toggleFindBar() {
  const bar = findbarEl();
  if (!bar) return;
  if (bar.hidden) openFindBar();
  else closeFindBar();
}

function initSubtitleEditor() {
  if (initialized) return;
  if (!modalEl()) return;
  initialized = true;

  // Wrap every editor click handler in an aria-disabled guard so the
  // "disabled" state is honoured even though we're no longer using
  // the native `disabled` attribute (see setEnabled() above).
  const guarded = (fn) => (event) => {
    if (!isEnabled(event.currentTarget)) { event.preventDefault(); return; }
    fn(event);
  };

  saveBtn()?.addEventListener('click', guarded(handleSave));
  revertBtn()?.addEventListener('click', guarded(handleRevert));
  cancelBtn()?.addEventListener('click', handleClose);
  closeBtn()?.addEventListener('click', handleClose);

  undoBtn()?.addEventListener('click', guarded(undo));
  redoBtn()?.addEventListener('click', guarded(redo));
  findToggleBtn()?.addEventListener('click', toggleFindBar);
  findInputEl()?.addEventListener('input', computeMatches);
  findCaseEl()?.addEventListener('change', computeMatches);
  findPrevBtn()?.addEventListener('click', guarded(() => stepMatch(-1)));
  findNextBtn()?.addEventListener('click', guarded(() => stepMatch(1)));
  replaceOneBtn()?.addEventListener('click', guarded(replaceCurrent));
  replaceAllBtn()?.addEventListener('click', guarded(replaceAll));

  // Enter in find = next; Shift+Enter = prev.  Enter in replace =
  // replaceCurrent so users can hammer through matches one at a time.
  //
  // IME guard: 注音/Pinyin/Kana IMEs use Enter to commit the composed
  // candidate.  During composition the event fires with
  // `isComposing === true` (and `keyCode === 229` on older Electron);
  // swallowing those would destroy the user's in-progress typing,
  // which bit us before on the replace box.
  const isComposing = (e) => e.isComposing || e.keyCode === 229;

  findInputEl()?.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (findState.matches.length === 0) computeMatches();
      stepMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });
  replaceInputEl()?.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceCurrent();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });

  // Intentionally NO backdrop-click-to-close here: mis-aiming at the
  // dim overlay while reaching for the scrollbar or just selecting
  // text in a row is far too easy, and nuking unsaved edits is a
  // high-cost accident.  Close buttons / Esc / menu are the only
  // exits.

  document.addEventListener('keydown', (event) => {
    const m = modalEl();
    if (!m || m.hidden) return;
    // IME guard — Chinese/Japanese input methods use Escape to
    // cancel an in-progress composition.  Swallowing that for a
    // modal close would lose the user's typed context mid-word.
    if (event.isComposing || event.keyCode === 229) return;
    const mod = event.metaKey || event.ctrlKey;
    // Undo / Redo — handled globally so they work regardless of which
    // textarea has focus, and so they override the browser's per-
    // textarea native undo stack (which would only undo within one
    // segment at a time, not across them).
    if (mod && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      undo();
      return;
    }
    if (mod && ((event.shiftKey && (event.key === 'z' || event.key === 'Z')) || event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      redo();
      return;
    }
    if (mod && event.key === 'f') {
      event.preventDefault();
      openFindBar();
      return;
    }
    if (event.key === 'Escape') {
      // If the find bar is open, let its own handler close it first —
      // this global handler only triggers when the bar isn't the
      // focused surface.
      const bar = findbarEl();
      if (bar && !bar.hidden) { closeFindBar(); event.preventDefault(); return; }
      event.preventDefault();
      handleClose();
    } else if (mod && event.key === 's') {
      event.preventDefault();
      handleSave();
    }
  });

  onLanguageChanged(async () => {
    const m = modalEl();
    if (!m || m.hidden) return;
    renderMeta(await readEnabledFormats());
    updateSaveButton();
  });
}

async function openSubtitleEditor({ mediaPath, outputDir }) {
  initSubtitleEditor();
  const m = modalEl();
  if (!m) return;

  const result = await window.electronAPI.transcript.read({ mediaPath, outputDir });
  if (!result || result.ok === false) {
    const msg = result?.message || t('transcript:empty.genericError');
    showToast(t('transcript:editor.toast.openFailed', { error: msg }), 'error', 3500);
    return;
  }

  const sourceFormat = (result.source || '').split('.').pop()?.toLowerCase() || '';
  // Flatten any existing multi-line segments into single lines —
  // this editor enforces single-line segments, and keeping stray
  // newlines would let them leak back into the file on save.
  const segs = (result.segments || []).map((s) => ({
    start: Number(s.start) || 0,
    end:   Number(s.end) || 0,
    text:  String(s.text || '').replace(/\s*\n+\s*/g, ' '),
  }));

  state = {
    mediaPath: mediaPath || null,
    outputDir: outputDir || null,
    sourceFormat,
    original: segs,
    draft:    segs.map((s) => ({ ...s })),
    dirty: false,
    saving: false,
    history: [], historyIndex: -1, savedIndex: -1,
  };

  filenameEl().textContent = basename(mediaPath);
  renderMeta(await readEnabledFormats());
  renderRows();
  resetHistory();
  clearDirty();
  m.hidden = false;
}

export { initSubtitleEditor, openSubtitleEditor };
