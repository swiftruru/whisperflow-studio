'use strict';

const ERROR_CODES = {
  UNKNOWN_RUNTIME_ERROR: 'UNKNOWN_RUNTIME_ERROR',
  CONFIG_JSON_INVALID: 'CONFIG_JSON_INVALID',
  MISSING_WHISPER_TOOL_PATH: 'MISSING_WHISPER_TOOL_PATH',
  INVALID_WHISPER_TOOL_PATH: 'INVALID_WHISPER_TOOL_PATH',
  INVALID_WHISPER_TOOL_PROJECT: 'INVALID_WHISPER_TOOL_PROJECT',
  INVALID_POETRY_PATH: 'INVALID_POETRY_PATH',
  POETRY_NOT_FOUND: 'POETRY_NOT_FOUND',
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
  title = '執行失敗',
  message = '發生未預期錯誤。',
  details = '',
  severity = 'error',
  suggestedAction = null,
  actionPayload = null,
  source = 'runtime',
  meta = null,
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
    title: value.title || fallback.title || '執行失敗',
    message: value.message || fallback.message || '發生未預期錯誤。',
    details: value.details || value.detail || fallback.details || '',
    severity: value.severity || fallback.severity || (value.status === 'warning' ? 'warning' : 'error'),
    suggestedAction: value.suggestedAction || action?.type || fallback.suggestedAction || null,
    actionPayload: value.actionPayload || normalizeActionPayload(action) || fallback.actionPayload || null,
    source: value.source || fallback.source || 'runtime',
    meta: value.meta || fallback.meta || null,
  });
}

function normalizeUnknownError(error, fallback = {}) {
  if (!error) return createAppError(fallback);

  if (typeof error === 'string') {
    return toAppError(error, fallback);
  }

  const message = error.message || fallback.message || '發生未預期錯誤。';
  const details = error.stack || error.message || String(error);

  return createAppError({
    ...fallback,
    message,
    details,
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
