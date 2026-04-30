'use strict';

import { t } from '../lib/i18n.js';

let autoScroll = true;
const outputEl    = document.getElementById('console-output');
const statusLabel = document.getElementById('status-badge');
const statusDot   = document.getElementById('status-dot');

// Current status token ('idle' / 'running' / 'paused' / 'error' / ...) — lets
// us re-render on language change without callers needing to re-pass a
// translated string.  `null` means the status has never been set.
let _currentStatusKey = null;

function classifyLine(text) {
  // Whisper subtitle-timestamp lines — e.g. "[00:00:12.000 -> 00:00:15.000] spoken text".
  // The content after the timestamp is transcribed user speech, so
  // spoken words like "error" / "失敗" must NOT trigger the error
  // colour. Short-circuit these to neutral before any keyword match.
  if (/^\s*\[\d{2}:\d{2}(?::\d{2})?[:.]\d+\s*->\s*\d{2}:\d{2}(?::\d{2})?[:.]\d+\]/.test(text)) return '';

  // ✔ / ✓ prefix means "this is a positive summary line". Must be
  // checked before the error keyword pass because success summaries
  // legitimately contain "失敗" / "failed" with a zero count
  // ("✔ 批次完成：1 完成、0 失敗、0 略過").
  if (/^\s*[✓✔]/.test(text)) return 'ok';

  const lower = text.toLowerCase();
  if (/error|traceback|exception|失敗|錯誤/.test(lower)) return 'error';
  if (/warning|warn|警告/.test(lower))          return 'warn';
  // Match "done / success / complete" + the two check-mark glyphs we
  // emit (✓ U+2713, ✔ U+2714). Chinese keywords cover the localized
  // completion + subtitle-generated messages so green highlighting
  // works in both locales.
  if (/done|success|✓|✔|complete|subtitles? (generated|created)|完成|成功|已產生|已停止|已跳過/.test(lower)) return 'ok';
  // Both main-process (`[WhisperFlow]`) and Python backend (`[Python]`)
  // app messages classify as info unless a stronger keyword (error /
  // warn / complete) elsewhere in the line upgrades them above.  The
  // ok / error / warn branches above already ran first, so this only
  // catches neutral status lines like "載入 faster-whisper 模型..." or
  // "silero VAD scanning ...".
  if (/\[whisperflow\]|\[python\]/.test(lower))  return 'info';
  return '';
}

function timestamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}

function appendLog(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line === '' && outputEl.lastChild?.textContent === '') continue;
    const span = document.createElement('span');
    span.className = `log-line ${classifyLine(line)}`;
    if (line !== '') {
      const ts = document.createElement('span');
      ts.className = 'log-ts';
      ts.textContent = timestamp();
      span.appendChild(ts);
      span.appendChild(document.createTextNode(' ' + line));
    }
    if (_activeFilter && !span.classList.contains(_activeFilter)) span.hidden = true;
    outputEl.appendChild(span);
  }
  if (autoScroll) outputEl.scrollTop = outputEl.scrollHeight;
}

function clearLog() {
  outputEl.innerHTML = '';
}

function copyLog() {
  navigator.clipboard.writeText(outputEl.innerText).catch(() => {});
}

let _timerInterval = null;
let _timerStart    = null;
let _currentStage  = '';

// Map from the Python EventEmitter's stage string to a short human label
// shown next to the "Running 00:47" timer.  The values come from
// python/whisperflow/events.py STAGE_* constants.
const STAGE_LABELS = {
  'preparing':       'Preparing',
  'loading-model':   'Loading model',
  'transcribing':    'Transcribing',
  'writing-subtitle': 'Writing SRT',
  'completed':       'Completed',
  'failed':          'Failed',
};

function renderRunningTimer() {
  if (_timerStart === null) return;

  const elapsed = Math.max(0, Math.floor((Date.now() - _timerStart) / 1000));
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const suffix = _currentStage ? ` · ${_currentStage}` : '';
  const runningLabel = t('controls:status.running', { defaultValue: 'Running' });
  statusLabel.textContent = `${runningLabel} ${mm}:${ss}${suffix}`;
}

function startTimer() {
  stopTimer();
  _timerStart = Date.now();
  renderRunningTimer();
  _timerInterval = setInterval(renderRunningTimer, 1000);
}

function stopTimer() {
  if (_timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
    _timerStart = null;
  }
}

/**
 * Set the top-right status badge.  Accepts a locale-agnostic state token
 * ('idle' / 'running' / 'paused' / 'skipping' / 'stopping' / 'setup' /
 * 'checking' / 'error').  Translation happens inside here so a language
 * switch can re-render via `refreshStatus()` without the caller needing
 * to re-supply a translated string.
 *
 * Backwards-compat: legacy callers passed the already-translated text
 * directly (e.g. 'Running' / 'Error').  We map those to the matching
 * token so existing call sites keep working during the refactor.
 */
function setStatus(stateOrKey) {
  const key = normalizeStatusKey(stateOrKey);
  _currentStatusKey = key;
  renderCurrentStatus();
}

function normalizeStatusKey(value) {
  if (!value) return 'idle';
  const known = ['idle', 'running', 'paused', 'skipping', 'stopping', 'setup', 'checking', 'error', 'completed'];
  if (known.includes(value)) return value;
  if (value === 'Running') return 'running';
  if (value === 'Error') return 'error';
  // Unknown — store the raw string as a leaf and render it as-is.  This
  // keeps ad-hoc status messages (that never had an i18n key) working
  // even if they won't be translated on language switch.
  return { raw: String(value) };
}

function renderCurrentStatus() {
  if (_currentStatusKey === null) return;
  statusLabel.className = 'status-label';
  statusDot.className   = 'status-dot';

  if (typeof _currentStatusKey === 'object' && _currentStatusKey.raw) {
    stopTimer();
    _currentStage = '';
    statusLabel.textContent = _currentStatusKey.raw;
    return;
  }

  if (_currentStatusKey === 'running') {
    statusLabel.classList.add('running');
    statusDot.classList.add('running');
    // Only (re)start the timer when transitioning INTO the running
    // state — if it's already running (e.g. we got here because of a
    // language switch, not a state change), we just re-render the
    // existing elapsed time using the new locale.  Otherwise startTimer()
    // would reset _timerStart to Date.now() and the elapsed counter would
    // visibly jump back to 00:00 every time the user flips languages.
    if (_timerStart === null) {
      _currentStage = '';
      startTimer();
    } else {
      renderRunningTimer();
    }
    return;
  }

  stopTimer();
  _currentStage = '';
  statusLabel.textContent = t(`controls:status.${_currentStatusKey}`, {
    defaultValue: _currentStatusKey,
  });
  if (_currentStatusKey === 'error') {
    statusLabel.classList.add('error');
    statusDot.classList.add('error');
  }
}

/**
 * Re-render the status badge using the last-set state key.  Called on
 * language change so the badge text follows the new locale.
 */
function refreshStatus() {
  renderCurrentStatus();
}

// Re-render on language switch.  Timer-based rendering inside
// `renderRunningTimer()` will also use the new t() result on its next
// tick, but refreshing here means paused / idle / setup states update
// instantly instead of waiting for the next subscribeQueueState fire.
window.addEventListener('app:language-changed', () => {
  refreshStatus();
});

// Called from queue-panel.js whenever a [WhisperFlowEvent] with a
// ``stage`` field arrives, so the top-right status badge always shows
// the current transcription phase even when the Batch Progress card is
// scrolled off screen.
function setStage(stage) {
  const label = STAGE_LABELS[stage] || '';
  if (label === _currentStage) return;
  _currentStage = label;
  // If the timer is running, re-render immediately so the change shows
  // without waiting for the next 1-second tick.
  if (_timerStart !== null) renderRunningTimer();
}

async function saveLog() {
  await window.electronAPI.saveLog(outputEl.innerText);
}

// Button wiring
document.getElementById('btn-clear-log').addEventListener('click', clearLog);
document.getElementById('btn-copy-log').addEventListener('click', copyLog);
document.getElementById('btn-save-log').addEventListener('click', saveLog);

// ── Console Log Filters ───────────────────────────────────────────────────────
let _activeFilter = '';

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _activeFilter = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilter();
  });
});

function applyFilter() {
  outputEl.querySelectorAll('.log-line').forEach(el => {
    if (!_activeFilter) {
      el.hidden = false;
    } else {
      el.hidden = !el.classList.contains(_activeFilter);
    }
  });
}

const scrollBtn = document.getElementById('btn-scroll-lock');
scrollBtn.addEventListener('click', () => {
  autoScroll = !autoScroll;
  scrollBtn.style.opacity = autoScroll ? '1' : '0.4';
});

// ── Console Search ────────────────────────────────────────────────────────────
const searchBar    = document.getElementById('console-search');
const searchInput  = document.getElementById('console-search-input');
const searchCount  = document.getElementById('console-search-count');

function runSearch(query) {
  const lines = outputEl.querySelectorAll('.log-line');
  let count = 0;
  lines.forEach(el => {
    el.classList.remove('search-match', 'search-match-active');
    if (query && el.textContent.toLowerCase().includes(query.toLowerCase())) {
      el.classList.add('search-match');
      count++;
    }
  });
  searchCount.textContent = query ? `${count} 筆` : '';
}

function openSearch() {
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchBar.hidden = true;
  searchInput.value = '';
  runSearch('');
}

searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSearch();
});
document.getElementById('btn-search-close').addEventListener('click', closeSearch);

function getRecentLogLines(n = 500) {
  if (!outputEl) return [];
  const text = outputEl.innerText || '';
  const lines = text.split('\n');
  return lines.slice(-n);
}

export { openSearch, getRecentLogLines };

function formatRunErrorLog(payload) {
  if (!payload) return '[ERROR] 發生未預期錯誤。\n';
  if (typeof payload === 'string') return `[ERROR] ${payload}\n`;

  const code = payload.code ? `[${payload.code}] ` : '';
  const details = payload.details ? `\n${payload.details}` : '';
  return `[ERROR] ${code}${payload.message || '發生未預期錯誤。'}${details}\n`;
}

// IPC listeners
window.electronAPI.onLogData((text) => {
  appendLog(text);
});

window.electronAPI.onRunError((payload) => {
  appendLog(formatRunErrorLog(payload));
  setStatus('error');
});

export { appendLog, clearLog, setStage, setStatus };
