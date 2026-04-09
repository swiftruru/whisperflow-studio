'use strict';

import { clearActiveError, setActiveError } from './error-state.js';
import { refreshPreflight } from './preflight-panel.js';
import { getQueueState } from './queue-state.js';
import { triggerRun, triggerScan } from './controls-bar.js';
import { showToast } from './toast.js';

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
      return '前往設定';
    case 'rerun-preflight':
      return '重新檢查';
    case 'retry-run':
      return '重新執行';
    case 'retry-scan':
      return '重新掃描';
    case 'open-folder':
      return '開啟資料夾';
    case 'dismiss-error':
      return '關閉提示';
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
    showToast('系統檢查已通過', 'success', 1800);
    return {
      handled: true,
      shouldCloseDialog: true,
    };
  }

  setActiveError(result.blockingChecks[0] || {
    code: 'PREFLIGHT_BLOCKED',
    title: '環境檢查未通過',
    message: '請先修正環境設定後再執行。',
    suggestedAction: 'open-settings',
    source: 'preflight',
  });

  showToast('仍有環境設定需要修正', 'info', 2200);
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
    showToast('目前無法重新執行，請先修正環境設定或確認佇列內容。', 'error');
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
    showToast('目前無法重新掃描，請先確認媒體資料夾設定。', 'error');
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
    showToast('找不到可開啟的資料夾或檔案路徑。', 'error');
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
    const message = error?.message || '執行錯誤處理動作時發生未預期錯誤。';
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
