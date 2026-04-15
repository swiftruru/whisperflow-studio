'use strict';

// Shared helper for the "create Python venv" flow.
// Wraps window.electronAPI.initializeVenv() with a pip-output parser so UI
// callers can render a live "目前階段" line next to their "立即建立環境"
// button while the install runs.
//
// Used from both:
//   - components/preflight-panel.js (main-tab System Check)
//   - components/model-manager.js (Models tab CTA)
//
// The parser is heuristic: pip is not promised to be stable in its output
// format, but these three patterns have been steady for years:
//
//   Creating virtualenv at …                       (our own banner)
//   Upgrading pip…                                  (our own banner)
//   Collecting <package>                            (download phase)
//   Installing collected packages: a, b, c          (install phase)
//   Successfully installed …                        (done)


const STAGE_PATTERNS = [
  { re: /Creating virtualenv at/i,                 label: () => '建立虛擬環境目錄…' },
  { re: /Upgrading pip/i,                          label: () => '升級 pip…' },
  { re: /Installing dependencies from/i,           label: () => '開始安裝依賴…' },
  { re: /^Collecting\s+([^\s(<>=!~]+)/,            label: (m) => `下載中：${m[1]}` },
  { re: /^Downloading\s+([^\s]+)/,                 label: (m) => `下載中：${m[1].split('/').pop()}` },
  { re: /^Installing collected packages:\s*(.+)$/, label: (m) => `安裝套件：${m[1].split(',')[0].trim()}…` },
  { re: /^Successfully installed/i,                label: () => '依賴安裝完成' },
];


function parseStage(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const { re, label } of STAGE_PATTERNS) {
    const match = trimmed.match(re);
    if (match) return label(match);
  }
  return null;
}


/**
 * Custom DOM event dispatched on `window` after a successful venv bootstrap.
 * Components that cache venv-dependent state (preflight, model manager,
 * settings model dropdown) listen for this and refresh themselves so the
 * user doesn't see stale "venv not initialised" warnings on other tabs.
 */
export const VENV_INITIALIZED_EVENT = 'whisperflow:venv-initialized';

/**
 * Run the venv bootstrap and stream stage-level progress updates.
 *
 * @param {Object} options
 * @param {(stage: string) => void} options.onStage - called whenever the
 *        pip parser detects a new stage (e.g. "下載中：torch").
 * @returns {Promise<void>} resolves when `initializeVenv` finishes,
 *        rejects with the same error it would throw.
 */
export async function initializeVenvWithProgress({ onStage }) {
  const notify = typeof onStage === 'function' ? onStage : () => {};

  // Buffer partial chunks so we only parse complete lines.
  let buffer = '';
  const parseChunk = (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const stage = parseStage(line);
      if (stage) notify(stage);
    }
  };

  const unsubscribe = window.electronAPI.addLogDataListener(parseChunk);

  try {
    await window.electronAPI.initializeVenv();
    // Broadcast so every panel that cached venv state (preflight, model
    // manager, settings model dropdown) can refresh itself.  We dispatch
    // BEFORE returning so callers' own post-await refresh sees the same
    // updated state.
    window.dispatchEvent(new CustomEvent(VENV_INITIALIZED_EVENT));
  } finally {
    // Drain any trailing partial line in the buffer before tearing down.
    if (buffer.trim()) {
      const stage = parseStage(buffer);
      if (stage) notify(stage);
    }
    unsubscribe?.();
  }
}
