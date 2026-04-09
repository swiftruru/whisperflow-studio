'use strict';

const RUNNER_EVENT_PREFIX = '[WhisperFlowEvent]';

const RUNNER_STAGES = Object.freeze({
  PREPARING: 'preparing',
  LOADING_MODEL: 'loading-model',
  VAD: 'vad',
  TRANSCRIBING: 'transcribing',
  WRITING_SUBTITLE: 'writing-subtitle',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRunnerEvent(raw = {}) {
  const stage = raw.stage ? String(raw.stage) : '';
  const type = raw.type ? String(raw.type) : (stage ? 'stage' : 'metric');

  return {
    type,
    stage,
    message: raw.message ? String(raw.message) : '',
    progress: toNullableNumber(raw.progress),
    elapsedSeconds: toNullableNumber(raw.elapsedSeconds),
    etaSeconds: toNullableNumber(raw.etaSeconds),
    filePath: raw.filePath ? String(raw.filePath) : '',
    fileName: raw.fileName ? String(raw.fileName) : '',
    timestamp: raw.timestamp ? String(raw.timestamp) : new Date().toISOString(),
    source: raw.source ? String(raw.source) : 'bridge',
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : null,
  };
}

function createRunnerEvent(partial = {}) {
  return normalizeRunnerEvent(partial);
}

function isRunnerEventLine(line = '') {
  return String(line).startsWith(RUNNER_EVENT_PREFIX);
}

function parseRunnerEventLine(line = '') {
  const text = String(line || '').trim();
  if (!isRunnerEventLine(text)) return null;

  const payloadText = text.slice(RUNNER_EVENT_PREFIX.length).trim();
  if (!payloadText) return null;

  try {
    const parsed = JSON.parse(payloadText);
    return normalizeRunnerEvent(parsed);
  } catch (_) {
    return null;
  }
}

module.exports = {
  RUNNER_EVENT_PREFIX,
  RUNNER_STAGES,
  createRunnerEvent,
  isRunnerEventLine,
  normalizeRunnerEvent,
  parseRunnerEventLine,
};
