'use strict';

import { t } from './i18n.js';

// Shared helper for the "create Python venv" and "update its
// dependencies" flows.  Wraps the matching electronAPI call with a
// pip-output parser so UI callers can render a live stage line next to
// their button while the install runs.
//
// Used from:
//   - components/preflight-panel.js (main-tab System Check)
//   - components/model-manager.js (Models tab CTA)
//
// The parser is heuristic: pip makes no promise about its output format,
// but these four patterns have been steady for years:
//
//   Collecting <package>                            (resolve phase)
//   Downloading <url>                               (download phase)
//   Installing collected packages: a, b, c          (install phase)
//   Successfully installed …                        (done)
//
// It used to also match our own three banners ("Creating virtualenv at",
// "Upgrading pip", "Installing dependencies from").  Those could never
// fire: venv-installer.js emits them through t(), so under the default
// zh-TW locale the lines never looked like the English regexes.  They are
// gone rather than re-written, because matching translated text would
// break again on the next copy edit.


const STAGE_PATTERNS = [
  { re: /^Collecting\s+([^\s(<>=!~]+)/,            key: 'collecting', params: (m) => ({ package: m[1] }) },
  { re: /^Downloading\s+([^\s]+)/,                 key: 'downloading', params: (m) => ({ file: m[1].split('/').pop() }) },
  { re: /^Installing collected packages:\s*(.+)$/, key: 'installing', params: (m) => ({ package: m[1].split(',')[0].trim() }) },
  { re: /^Successfully installed/i,                key: 'done', params: () => ({}) },
];


function parseStage(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const { re, key, params } of STAGE_PATTERNS) {
    const match = trimmed.match(re);
    if (match) return t(`events:log.pipStage.${key}`, params(match));
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
 * Run a pip-driven operation, streaming stage-level progress updates.
 *
 * Shared by both entry points below: the only difference between them is
 * which electronAPI call they make.
 *
 * @param {() => Promise<unknown>} run - the IPC call to await.
 * @param {Object} options
 * @param {(stage: string) => void} options.onStage - called whenever the
 *        pip parser detects a new stage (e.g. "Downloading: torch").
 * @returns {Promise<void>} resolves when `run` finishes, rejects with the
 *        same error it would throw.
 */
async function runWithPipProgress(run, { onStage }) {
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
    await run();
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

/**
 * Create the bundled venv and install its dependencies.
 *
 * @param {Object} options
 * @param {(stage: string) => void} options.onStage
 * @returns {Promise<void>}
 */
export async function initializeVenvWithProgress({ onStage }) {
  await runWithPipProgress(() => window.electronAPI.initializeVenv(), { onStage });
}

/**
 * Re-run `pip install -r requirements.txt` in an existing venv.
 *
 * Needed because the venv is built once and then never revisited: an
 * existing user whose requirements.txt gained an entry (sherpa-onnx, for
 * instance) would otherwise never install it.  pip is incremental, so this
 * is fast when everything is already satisfied.
 *
 * @param {Object} options
 * @param {(stage: string) => void} options.onStage
 * @returns {Promise<void>}
 */
export async function updateVenvRequirementsWithProgress({ onStage }) {
  await runWithPipProgress(() => window.electronAPI.updateVenvRequirements(), { onStage });
}
