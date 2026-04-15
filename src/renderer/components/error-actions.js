'use strict';

import { clearActiveError, setActiveError } from './error-state.js';
import { refreshPreflight } from './preflight-panel.js';
import { getQueueState } from './queue-state.js';
import { triggerRun, triggerScan } from './controls-bar.js';
import { showToast } from './toast.js';
import { t } from '../lib/i18n.js';

function normalizeActionInput(actionOrError, payload = null) {
  if (!actionOrError) return { actionType: null, actionPayload: payload };

  if (typeof actionOrError === 'string') {
    return {
      actionType: actionOrError,
      actionPayload: payload || null,
      sourceError: null,
    };
  }

  return {
    actionType: actionOrError.suggestedAction || actionOrError.action?.type || null,
    actionPayload: actionOrError.actionPayload || payload || null,
    sourceError: actionOrError,
  };
}

function getActionLabel(actionType) {
  switch (actionType) {
    case 'open-settings':
      return t('errors:actions.openSettings');
    case 'rerun-preflight':
      return t('errors:actions.rerunPreflight');
    case 'retry-run':
      return t('errors:actions.retryRun');
    case 'retry-scan':
      return t('errors:actions.retryScan');
    case 'open-folder':
      return t('errors:actions.openFolder');
    case 'dismiss-error':
      return t('errors:actions.dismiss');
    default:
      return '';
  }
}

function openSettingsField(section, key) {
  const tabBtn = document.querySelector('[data-tab="settings"]');
  tabBtn?.click();

  requestAnimationFrame(() => {
    if (!section || !key) return;

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

async function rerunPreflight() {
  const result = await refreshPreflight();

  if (result.ok) {
    clearActiveError();
    showToast(t('errors:toast.preflightPassed'), 'success', 1800);
    return {
      handled: true,
      shouldCloseDialog: true,
    };
  }

  setActiveError(result.blockingChecks[0] || {
    code: 'PREFLIGHT_BLOCKED',
    titleKey: 'errors:PREFLIGHT_BLOCKED.title',
    messageKey: 'errors:PREFLIGHT_BLOCKED.message',
    suggestedAction: 'open-settings',
    source: 'preflight',
  });

  showToast(t('errors:toast.preflightStillFailing'), 'info', 2200);
  return {
    handled: true,
    shouldCloseDialog: false,
  };
}

async function retryRun() {
  const queueState = getQueueState();
  if (queueState.stats.failed > 0) {
    await window.electronAPI.retryFailedQueueJobs();
  }

  const started = await triggerRun();
  if (!started) {
    showToast(t('errors:toast.retryRunBlocked'), 'error');
    return {
      handled: false,
      shouldCloseDialog: false,
    };
  }

  clearActiveError();
  return {
    handled: true,
    shouldCloseDialog: true,
  };
}

async function retryScan() {
  const started = await triggerScan();
  if (!started) {
    showToast(t('errors:toast.retryScanBlocked'), 'error');
    return {
      handled: false,
      shouldCloseDialog: false,
    };
  }

  clearActiveError();
  return {
    handled: true,
    shouldCloseDialog: true,
  };
}

async function openFolder(actionPayload = {}) {
  const path = actionPayload.filePath || actionPayload.path || actionPayload.dirPath || '';
  if (!path) {
    showToast(t('errors:toast.openFolderMissing'), 'error');
    return {
      handled: false,
      shouldCloseDialog: false,
    };
  }

  await window.electronAPI.showInFolder(path);
  return {
    handled: true,
    shouldCloseDialog: true,
  };
}

async function performErrorAction(actionOrError, payload = null) {
  const { actionType, actionPayload, sourceError } = normalizeActionInput(actionOrError, payload);

  try {
    switch (actionType) {
      case 'open-settings':
        openSettingsField(actionPayload?.section, actionPayload?.key);
        return {
          handled: true,
          shouldCloseDialog: false,
        };

      case 'rerun-preflight':
        return rerunPreflight();

      case 'retry-run':
        return retryRun();

      case 'retry-scan':
        return retryScan();

      case 'open-folder':
        return openFolder(actionPayload || sourceError?.meta || {});

      case 'dismiss-error':
        clearActiveError();
        return {
          handled: true,
          shouldCloseDialog: true,
        };

      default:
        return {
          handled: false,
          shouldCloseDialog: false,
        };
    }
  } catch (error) {
    const message = error?.message || t('errors:toast.actionHandlerFailed');
    showToast(message, 'error');
    return {
      handled: false,
      shouldCloseDialog: false,
    };
  }
}

export {
  getActionLabel,
  openSettingsField,
  performErrorAction,
};
