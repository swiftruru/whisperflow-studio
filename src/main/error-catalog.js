'use strict';

const ERROR_CODES = {
  UNKNOWN_RUNTIME_ERROR: 'UNKNOWN_RUNTIME_ERROR',
  CONFIG_JSON_INVALID: 'CONFIG_JSON_INVALID',
  BUNDLED_PYTHON_NOT_FOUND: 'BUNDLED_PYTHON_NOT_FOUND',
  VENV_NOT_INITIALIZED: 'VENV_NOT_INITIALIZED',
  VENV_INIT_FAILED: 'VENV_INIT_FAILED',
  WHISPERFLOW_PACKAGE_MISSING: 'WHISPERFLOW_PACKAGE_MISSING',
  FFMPEG_NOT_FOUND: 'FFMPEG_NOT_FOUND',
  VC_REDIST_NOT_FOUND: 'VC_REDIST_NOT_FOUND',
  MEDIA_ROOT_NOT_FOUND: 'MEDIA_ROOT_NOT_FOUND',
  CLI_ENTRY_NOT_FOUND: 'CLI_ENTRY_NOT_FOUND',
  SCAN_SCRIPT_NOT_FOUND: 'SCAN_SCRIPT_NOT_FOUND',
  SCAN_FAILED: 'SCAN_FAILED',
  PREFLIGHT_BLOCKED: 'PREFLIGHT_BLOCKED',
  RUNNER_START_FAILED: 'RUNNER_START_FAILED',
  RUNNER_PAUSE_FAILED: 'RUNNER_PAUSE_FAILED',
  RUNNER_RESUME_FAILED: 'RUNNER_RESUME_FAILED',
  RUNNER_STOP_FAILED: 'RUNNER_STOP_FAILED',
  RUNNER_SKIP_FAILED: 'RUNNER_SKIP_FAILED',
  QUEUE_JOB_NOT_FOUND: 'QUEUE_JOB_NOT_FOUND',
  QUEUE_JOB_NOT_RETRYABLE: 'QUEUE_JOB_NOT_RETRYABLE',
  QUEUE_JOB_NOT_REMOVABLE: 'QUEUE_JOB_NOT_REMOVABLE',
  QUEUE_JOB_NOT_MOVABLE: 'QUEUE_JOB_NOT_MOVABLE',
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  SUBTITLE_NOT_GENERATED: 'SUBTITLE_NOT_GENERATED',
};

function normalizeActionPayload(action = null) {
  if (!action || typeof action !== 'object') return null;

  const payload = { ...action };
  delete payload.type;
  return Object.keys(payload).length > 0 ? payload : null;
}

function slugifyCodePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function createAppError({
  code = ERROR_CODES.UNKNOWN_RUNTIME_ERROR,
  title = '',
  message = '',
  details = '',
  severity = 'error',
  suggestedAction = null,
  actionPayload = null,
  source = 'runtime',
  meta = null,
  // i18n contract: callers SHOULD pass titleKey / messageKey; the
  // legacy title / message strings are kept so half-migrated call sites
  // still work during the rollout.  Renderer-side display code prefers
  // the key when present.
  titleKey = null,
  titleParams = null,
  messageKey = null,
  messageParams = null,
  detailsKey = null,
  detailsParams = null,
} = {}) {
  return {
    code,
    title,
    message,
    details: details ? String(details) : '',
    severity,
    suggestedAction,
    actionPayload,
    source,
    meta,
    titleKey,
    titleParams,
    messageKey,
    messageParams,
    detailsKey,
    detailsParams,
  };
}

function createPreflightCode(key, status) {
  return `PREFLIGHT_${slugifyCodePart(key)}_${slugifyCodePart(status || 'idle')}`;
}

function toAppError(value, fallback = {}) {
  if (!value) {
    return createAppError(fallback);
  }

  if (typeof value === 'string') {
    return createAppError({
      ...fallback,
      message: value,
      details: fallback.details || '',
    });
  }

  const action = value.action || null;
  return createAppError({
    ...fallback,
    code: value.code || fallback.code || ERROR_CODES.UNKNOWN_RUNTIME_ERROR,
    title: value.title || fallback.title || '',
    message: value.message || fallback.message || '',
    details: value.details || value.detail || fallback.details || '',
    severity: value.severity || fallback.severity || (value.status === 'warning' ? 'warning' : 'error'),
    suggestedAction: value.suggestedAction || action?.type || fallback.suggestedAction || null,
    actionPayload: value.actionPayload || normalizeActionPayload(action) || fallback.actionPayload || null,
    source: value.source || fallback.source || 'runtime',
    meta: value.meta || fallback.meta || null,
    titleKey: value.titleKey || fallback.titleKey || null,
    titleParams: value.titleParams || fallback.titleParams || null,
    messageKey: value.messageKey || fallback.messageKey || null,
    messageParams: value.messageParams || fallback.messageParams || null,
    detailsKey: value.detailsKey || fallback.detailsKey || null,
    detailsParams: value.detailsParams || fallback.detailsParams || null,
  });
}

function normalizeUnknownError(error, fallback = {}) {
  if (!error) return createAppError(fallback);

  if (typeof error === 'string') {
    return toAppError(error, fallback);
  }

  const message = error.message || fallback.message || '';
  const details = error.stack || error.message || String(error);

  // If the caller tagged the Error with an i18nKey / i18nParams (the
  // convention for `throw new Error(CODE)` inside ipc-handlers that
  // wants a translated banner), propagate them into the app-error
  // payload so the renderer can localize at display time.
  return createAppError({
    ...fallback,
    message,
    details,
    messageKey: error.i18nKey || fallback.messageKey || null,
    messageParams: error.i18nParams || fallback.messageParams || null,
    code: error.code || fallback.code || ERROR_CODES.UNKNOWN_RUNTIME_ERROR,
  });
}

function createPreflightCheck({
  key,
  status = 'idle',
  code = '',
  title = '',
  message = '',
  detail = '',
  action = null,
  severity = null,
  titleKey = null,
  titleParams = null,
  messageKey = null,
  messageParams = null,
  detailKey = null,
  detailParams = null,
}) {
  const checkSeverity = severity || (status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'info');
  const appError = createAppError({
    code: code || createPreflightCode(key, status),
    title,
    message,
    details: detail,
    severity: checkSeverity,
    suggestedAction: action?.type || null,
    actionPayload: normalizeActionPayload(action),
    source: 'preflight',
    titleKey,
    titleParams,
    messageKey,
    messageParams,
    detailsKey: detailKey,
    detailsParams: detailParams,
  });

  return {
    key,
    status,
    title: appError.title,
    message: appError.message,
    detail: appError.details,
    action,
    code: appError.code,
    severity: appError.severity,
    suggestedAction: appError.suggestedAction,
    actionPayload: appError.actionPayload,
    details: appError.details,
    source: appError.source,
    titleKey: appError.titleKey,
    titleParams: appError.titleParams,
    messageKey: appError.messageKey,
    messageParams: appError.messageParams,
    detailKey: appError.detailsKey,
    detailParams: appError.detailsParams,
  };
}

module.exports = {
  ERROR_CODES,
  createAppError,
  createPreflightCheck,
  normalizeActionPayload,
  normalizeUnknownError,
  toAppError,
};
