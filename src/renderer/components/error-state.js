'use strict';

const subscribers = new Set();

let initialized = false;
let activeError = null;

function normalizeError(errorLike) {
  if (!errorLike) return null;

  if (typeof errorLike === 'string') {
    return {
      code: 'UNKNOWN_RUNTIME_ERROR',
      title: '執行失敗',
      message: errorLike,
      details: '',
      severity: 'error',
      suggestedAction: null,
      actionPayload: null,
      source: 'runtime',
      meta: null,
    };
  }

  return {
    code: errorLike.code || 'UNKNOWN_RUNTIME_ERROR',
    title: errorLike.title || '執行失敗',
    message: errorLike.message || '發生未預期錯誤。',
    details: errorLike.details || errorLike.detail || '',
    severity: errorLike.severity || 'error',
    suggestedAction: errorLike.suggestedAction || errorLike.action?.type || null,
    actionPayload: errorLike.actionPayload || null,
    source: errorLike.source || 'runtime',
    meta: errorLike.meta || null,
  };
}

function notifySubscribers() {
  subscribers.forEach((listener) => listener(activeError));
}

function setActiveError(errorLike) {
  activeError = normalizeError(errorLike);
  notifySubscribers();
  return activeError;
}

function clearActiveError() {
  activeError = null;
  notifySubscribers();
}

function getActiveError() {
  return activeError;
}

function subscribeErrorState(listener) {
  subscribers.add(listener);
  listener(activeError);

  return () => {
    subscribers.delete(listener);
  };
}

function initErrorState() {
  if (initialized) return activeError;
  initialized = true;

  window.electronAPI.onRunError((payload) => {
    setActiveError(payload);
  });

  window.electronAPI.onRunDone((code) => {
    if (code === 0 || code === -2 || code === -3) {
      clearActiveError();
    }
  });

  return activeError;
}

export {
  clearActiveError,
  getActiveError,
  initErrorState,
  setActiveError,
  subscribeErrorState,
};
