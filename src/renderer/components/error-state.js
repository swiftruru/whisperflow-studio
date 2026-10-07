'use strict';

const subscribers = new Set();

let initialized = false;
let activeError = null;

// The i18n half of an app error.  error-banner.js and error-dialog.js
// both resolve `titleKey` / `messageKey` in preference to the legacy
// `title` / `message` strings, so dropping these fields here silently
// disabled every localized error message: `createAppError` leaves
// `title: ''` on the run paths, so the hard-coded fallbacks below won.
// That is why INPUT_FILE_VANISHED and PREFLIGHT_BLOCKED never showed
// their copy. Keep this list in sync with createAppError in
// src/main/error-catalog.js.
const I18N_FIELDS = [
  'titleKey',
  'titleParams',
  'messageKey',
  'messageParams',
  'detailsKey',
  'detailsParams',
];

function pickI18nFields(errorLike) {
  const picked = {};
  for (const field of I18N_FIELDS) {
    picked[field] = errorLike?.[field] ?? null;
  }
  return picked;
}

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
      ...pickI18nFields(null),
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
    ...pickI18nFields(errorLike),
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
