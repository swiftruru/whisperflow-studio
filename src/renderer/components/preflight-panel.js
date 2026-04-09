'use strict';

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
}

function createActionButton(check) {
  if (!check.action?.type) return null;

  const button = document.createElement('button');
  button.className = 'btn-inline-action';
  button.type = 'button';

  if (check.action.type === 'open-settings') {
    button.textContent = '前往設定';
  } else if (check.action.type === 'browse-media-root') {
    button.textContent = '選擇資料夾';
  } else {
    return null;
  }

  button.addEventListener('click', async () => {
    await handleCheckAction(check.action);
    await refreshPreflight();
  });

  return button;
}

function renderChecks() {
  const visibleChecks = getVisibleChecks();

  if (state.pending) {
    panel.hidden = false;
    countEl.textContent = '檢查中';
    summaryEl.textContent = '正在檢查目前環境與設定…';
    listEl.innerHTML = '';
    return;
  }

  if (state.ok) {
    panel.hidden = true;
    listEl.innerHTML = '';
    return;
  }

  panel.hidden = false;
  countEl.textContent = `${state.blockingChecks.length} 項阻擋`;
  summaryEl.textContent = `還有 ${state.blockingChecks.length} 個環境問題需要先修正。`;
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
    title.textContent = check.title;

    const message = document.createElement('div');
    message.className = 'preflight-item-message';
    message.textContent = check.message;

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

    const actionButton = createActionButton(check);
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
              title: '環境檢查失敗',
              message: '無法完成 preflight 檢查，請稍後再試。',
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
          title: '環境檢查初始化失敗',
          message: 'Preflight UI 初始化時發生錯誤。',
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
            title: '環境檢查未完成',
            message: 'Preflight 在預期時間內沒有完成，請點擊重新檢查，或重新啟動 app。',
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
