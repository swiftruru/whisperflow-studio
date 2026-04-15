'use strict';

let autoScroll = true;
const outputEl    = document.getElementById('console-output');
const statusLabel = document.getElementById('status-badge');
const statusDot   = document.getElementById('status-dot');

function classifyLine(text) {
  const lower = text.toLowerCase();
  if (/error|traceback|exception/.test(lower)) return 'error';
  if (/warning|warn/.test(lower))              return 'warn';
  if (/done|success|✓|complete|subtitles? (generated|created)/.test(lower)) return 'ok';
  if (/\[whisperflow\]/.test(lower))           return 'info';
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
  statusLabel.textContent = `Running ${mm}:${ss}${suffix}`;
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

function setStatus(state) {
  statusLabel.className = 'status-label';
  statusDot.className   = 'status-dot';
  if (state === 'Running') {
    statusLabel.classList.add('running');
    statusDot.classList.add('running');
    _currentStage = '';  // reset stage on every fresh run
    startTimer();
  } else {
    stopTimer();
    _currentStage = '';
    statusLabel.textContent = state;
    if (state === 'Error') {
      statusLabel.classList.add('error');
      statusDot.classList.add('error');
    }
  }
}

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

export { openSearch };

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
  setStatus('Error');
});

export { appendLog, clearLog, setStage, setStatus };
