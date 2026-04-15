'use strict';

import { showToast } from './toast.js';
import { initializeVenvWithProgress, VENV_INITIALIZED_EVENT } from '../lib/venv-bootstrap.js';
import { openInstallFfmpegDialog } from './install-ffmpeg-dialog.js';
import { t } from '../lib/i18n.js';

/**
 * Translate a main-process payload (`{ titleKey, titleParams, title }`
 * shape) into a display string.  The payload ships both the i18n key
 * and a legacy raw string fallback so half-migrated call sites still
 * render something during the rollout — once every caller is on keys
 * the fallback becomes dead code and can be removed.
 */
function resolveI18nField(keyField, paramsField, fallbackField, obj) {
  const key = obj?.[keyField];
  if (key) return t(key, obj?.[paramsField] || undefined);
  return obj?.[fallbackField] || '';
}

const panel = document.getElementById('preflight-panel');
const summaryEl = document.getElementById('preflight-summary');
const listEl = document.getElementById('preflight-list');
const countEl = document.getElementById('preflight-count');
const recheckBtn = document.getElementById('btn-preflight-recheck');
const PREFLIGHT_TIMEOUT_MS = 4000;
let activeRefreshPromise = null;

const subscribers = new Set();

let onApplyDirectory = null;
let state = {
  pending: true,
  ok: false,
  checks: [],
  blockingChecks: [],
};

function notifySubscribers() {
  for (const listener of subscribers) {
    try {
      listener(state);
    } catch (error) {
      console.error('[WhisperFlow Studio] Preflight subscriber failed:', error);
    }
  }
}

function normalizePreflightResult(result = {}) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const blockingChecks = Array.isArray(result.blockingChecks)
    ? result.blockingChecks
    : checks.filter((check) => check.status === 'error');

  return {
    pending: false,
    ok: blockingChecks.length === 0,
    checks,
    blockingChecks,
    checkedAt: result.checkedAt || null,
  };
}

function getVisibleChecks() {
  return state.checks.filter((check) => check.status === 'error' || check.status === 'warning');
}

function openSettingsField(section, key) {
  const tabBtn = document.querySelector('[data-tab="settings"]');
  tabBtn?.click();

  requestAnimationFrame(() => {
    const field = document.querySelector(`[data-section="${section}"][data-key="${key}"]`);
    const group = field?.closest('.section-group');
    if (group?.hidden) {
      group.hidden = false;
      group.previousElementSibling?.classList.remove('collapsed');
      localStorage.setItem(`section-collapsed:${section}`, 'false');
    }
    field?.focus();
    field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

async function handleCheckAction(action) {
  if (!action?.type) return;

  if (action.type === 'open-settings') {
    openSettingsField(action.section, action.key);
    return;
  }

  if (action.type === 'browse-media-root') {
    const folder = await window.electronAPI.browseFolder();
    if (folder && onApplyDirectory) {
      await onApplyDirectory(folder);
    }
    return;
  }

  if (action.type === 'install-ffmpeg') {
    await openInstallFfmpegDialog(action.packageName || 'ffmpeg');
    return;
  }
}

async function runVenvInitializeFromButton(button, bodyEl) {
  const stageLine = document.createElement('div');
  stageLine.className = 'preflight-item-stage';
  stageLine.textContent = t('preflight:venvBootstrap.starting');
  bodyEl?.appendChild(stageLine);

  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = t('preflight:actionButtons.initializingVenv');
  showToast(t('toasts:venv.creating'), 'info', 5000);

  try {
    await initializeVenvWithProgress({
      onStage: (stage) => {
        stageLine.textContent = t('preflight:venvBootstrap.stage', { stage });
      },
    });
    stageLine.textContent = t('preflight:venvBootstrap.completed');
    showToast(t('toasts:venv.success'), 'success', 3000);
  } catch (error) {
    button.disabled = false;
    button.textContent = originalLabel;
    stageLine.remove();
    showToast(t('toasts:venv.failed', { error: error?.message || error }), 'error', 6000);
    throw error;
  }
}

function createActionButton(check, rowEl) {
  if (!check.action?.type) return null;

  const button = document.createElement('button');
  button.className = 'btn-inline-action';
  button.type = 'button';

  if (check.action.type === 'open-settings') {
    button.textContent = t('preflight:actionButtons.openSettings');
  } else if (check.action.type === 'browse-media-root') {
    button.textContent = t('preflight:actionButtons.browseMediaRoot');
  } else if (check.action.type === 'initialize-venv') {
    button.textContent = t('preflight:actionButtons.initializeVenv');
  } else if (check.action.type === 'install-ffmpeg') {
    button.textContent = t('preflight:actionButtons.installFfmpeg');
  } else {
    return null;
  }

  button.addEventListener('click', async () => {
    if (check.action.type === 'initialize-venv') {
      const bodyEl = rowEl?.querySelector('.preflight-item-body');
      try {
        await runVenvInitializeFromButton(button, bodyEl);
      } catch (_) {
        return;
      }
      await refreshPreflight();
      return;
    }
    await handleCheckAction(check.action);
    await refreshPreflight();
  });

  return button;
}

function renderChecks() {
  if (state.pending) {
    panel.hidden = false;
    countEl.textContent = t('preflight:panel.countChip.checking');
    summaryEl.textContent = t('preflight:panel.summary.checking');
    listEl.innerHTML = '';
    return;
  }

  const visibleChecks = getVisibleChecks();
  if (state.ok && visibleChecks.length === 0) {
    panel.hidden = true;
    listEl.innerHTML = '';
    return;
  }

  panel.hidden = false;
  if (state.blockingChecks.length > 0) {
    countEl.textContent = t('preflight:panel.countChip.blocking', { count: state.blockingChecks.length });
    summaryEl.textContent = t('preflight:panel.summary.blockingCount', { count: state.blockingChecks.length });
  } else {
    countEl.textContent = t('preflight:panel.countChip.warning', { count: visibleChecks.length });
    summaryEl.textContent = t('preflight:panel.summary.warningCount', { count: visibleChecks.length });
  }
  listEl.innerHTML = '';

  visibleChecks.forEach((check) => {
    const row = document.createElement('div');
    row.className = `preflight-item ${check.status}`;

    const icon = document.createElement('span');
    icon.className = 'preflight-item-icon';
    icon.textContent = check.status === 'error' ? '!' : 'i';

    const body = document.createElement('div');
    body.className = 'preflight-item-body';

    const title = document.createElement('div');
    title.className = 'preflight-item-title';
    title.textContent = resolveI18nField('titleKey', 'titleParams', 'title', check);

    const message = document.createElement('div');
    message.className = 'preflight-item-message';
    message.textContent = resolveI18nField('messageKey', 'messageParams', 'message', check);

    body.appendChild(title);
    body.appendChild(message);

    if (check.detail) {
      const detail = document.createElement('div');
      detail.className = 'preflight-item-detail';
      detail.textContent = check.detail;
      body.appendChild(detail);
    }

    row.appendChild(icon);
    row.appendChild(body);

    const actionButton = createActionButton(check, row);
    if (actionButton) row.appendChild(actionButton);

    listEl.appendChild(row);
  });
}

async function refreshPreflight() {
  try {
    if (activeRefreshPromise) {
      return activeRefreshPromise;
    }

    state = {
      ...state,
      pending: true,
    };
    renderChecks();
    notifySubscribers();

    activeRefreshPromise = (async () => {
      try {
        const result = await Promise.race([
          window.electronAPI.runPreflight(),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Preflight timed out after ${PREFLIGHT_TIMEOUT_MS}ms`)), PREFLIGHT_TIMEOUT_MS);
          }),
        ]);
        state = normalizePreflightResult(result);
      } catch (error) {
        state = normalizePreflightResult({
          checks: [
            {
              key: 'preflight_internal_error',
              status: 'error',
              titleKey: 'preflight:errorStates.internal.title',
              messageKey: 'preflight:errorStates.internal.message',
              detail: error.message,
            },
          ],
        });
      } finally {
        activeRefreshPromise = null;
      }

      renderChecks();
      notifySubscribers();
      return state;
    })();

    return activeRefreshPromise;
  } catch (error) {
    console.error('[WhisperFlow Studio] Preflight refresh crashed before completion:', error);
    state = normalizePreflightResult({
      checks: [
        {
          key: 'preflight_render_error',
          status: 'error',
          titleKey: 'preflight:errorStates.render.title',
          messageKey: 'preflight:errorStates.render.message',
          detail: error.message,
        },
      ],
    });
    renderChecks();
    notifySubscribers();
    return state;
  }
}

function getPreflightState() {
  return state;
}

function subscribePreflight(listener) {
  subscribers.add(listener);
  listener(state);

  return () => {
    subscribers.delete(listener);
  };
}

function initPreflightPanel(options = {}) {
  onApplyDirectory = options.onApplyDirectory || null;

  recheckBtn?.addEventListener('click', () => {
    refreshPreflight();
  });

  // After a successful venv bootstrap the preflight result is stale even
  // if the user kicked off the install from another tab — re-run.
  window.addEventListener(VENV_INITIALIZED_EVENT, () => {
    refreshPreflight();
  });

  // Re-render so the currently-shown check titles/messages switch to
  // the new language.  The underlying state still carries keys + params,
  // so we just re-run the renderer.
  window.addEventListener('app:language-changed', () => {
    renderChecks();
  });

  renderChecks();
  queueMicrotask(() => {
    if (state.pending) refreshPreflight();
  });
  setTimeout(() => {
    if (state.pending) {
      state = normalizePreflightResult({
        checks: [
          {
            key: 'preflight_stuck_timeout',
            status: 'error',
            titleKey: 'preflight:errorStates.stuck.title',
            messageKey: 'preflight:errorStates.stuck.message',
            detail: `UI watchdog exceeded ${PREFLIGHT_TIMEOUT_MS}ms`,
          },
        ],
      });
      renderChecks();
      notifySubscribers();
    }
  }, PREFLIGHT_TIMEOUT_MS + 500);
}

export {
  getPreflightState,
  initPreflightPanel,
  refreshPreflight,
  subscribePreflight,
};
