import { afterEach, describe, expect, it } from 'vitest';

// A renderer ES module, imported directly — `window` is only touched
// inside initErrorState(), which these tests never call.
import {
  clearActiveError,
  getActiveError,
  setActiveError,
} from '../../src/renderer/components/error-state.js';

afterEach(() => clearActiveError());

describe('normalizeError', () => {
  it('carries the i18n keys through to the banner', () => {
    // The regression this guards: error-banner.js and error-dialog.js both
    // resolve titleKey/messageKey in preference to the legacy title/message
    // strings, and createAppError leaves title/message empty on the run
    // paths.  Dropping these fields meant every localized error rendered as
    // the hard-coded Chinese fallback plus a raw English Python message.
    const normalized = setActiveError({
      code: 'DIARIZATION_MODEL_DOWNLOAD_FAILED',
      title: '',
      message: 'could not download the segmentation model',
      titleKey: 'errors:DIARIZATION_MODEL_DOWNLOAD_FAILED.title',
      messageKey: 'errors:DIARIZATION_MODEL_DOWNLOAD_FAILED.message',
      messageParams: { urls: 'https://example.test/a.onnx', path: '/models' },
      source: 'run',
    });

    expect(normalized.titleKey).toBe('errors:DIARIZATION_MODEL_DOWNLOAD_FAILED.title');
    expect(normalized.messageKey).toBe('errors:DIARIZATION_MODEL_DOWNLOAD_FAILED.message');
    expect(normalized.messageParams).toEqual({
      urls: 'https://example.test/a.onnx',
      path: '/models',
    });
    expect(normalized.detailsKey).toBeNull();
    expect(getActiveError()).toEqual(normalized);
  });

  it('exposes every i18n field even when the payload has none', () => {
    const normalized = setActiveError({ code: 'SCAN_FAILED', message: 'boom' });
    for (const field of ['titleKey', 'titleParams', 'messageKey', 'messageParams', 'detailsKey', 'detailsParams']) {
      expect(normalized).toHaveProperty(field, null);
    }
  });

  it('still falls back to the legacy strings and defaults', () => {
    const normalized = setActiveError({ code: 'SCAN_FAILED' });
    expect(normalized.title).toBe('執行失敗');
    expect(normalized.message).toBe('發生未預期錯誤。');
    expect(normalized.severity).toBe('error');
    expect(normalized.source).toBe('runtime');
  });

  it('normalizes a bare string payload', () => {
    const normalized = setActiveError('something broke');
    expect(normalized.code).toBe('UNKNOWN_RUNTIME_ERROR');
    expect(normalized.message).toBe('something broke');
    expect(normalized.messageKey).toBeNull();
  });

  it('derives suggestedAction from a nested action object', () => {
    const normalized = setActiveError({ code: 'X', action: { type: 'initialize-venv' } });
    expect(normalized.suggestedAction).toBe('initialize-venv');
  });

  it('returns null for an empty payload', () => {
    expect(setActiveError(null)).toBeNull();
    expect(getActiveError()).toBeNull();
  });
});
