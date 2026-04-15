'use strict';

import { subscribeErrorState } from './error-state.js';
import { getActionLabel, performErrorAction } from './error-actions.js';
import { showToast } from './toast.js';
import { t } from '../lib/i18n.js';

function localizeField(key, params, fallback) {
  if (key) return t(key, params || undefined);
  return fallback || '';
}

const overlay = document.getElementById('error-dialog');
const severityBadge = document.getElementById('error-dialog-severity');
const title = document.getElementById('error-dialog-title');
const code = document.getElementById('error-dialog-code');
const message = document.getElementById('error-dialog-message');
const details = document.getElementById('error-dialog-details');
const primaryButton = document.getElementById('btn-error-dialog-action');
const copyButton = document.getElementById('btn-error-dialog-copy');
const closeButton = document.getElementById('btn-error-dialog-close');

let initialized = false;
let dialogOpen = false;
let dialogError = null;

function formatErrorDetails(error) {
  const chunks = [];

  if (error?.code) chunks.push(`Code: ${error.code}`);
  if (error?.title) chunks.push(`Title: ${error.title}`);
  if (error?.message) chunks.push(`Message: ${error.message}`);
  if (error?.details) chunks.push(`Details:\n${error.details}`);

  return chunks.join('\n\n').trim();
}

function renderDialog() {
  if (!dialogOpen || !dialogError) {
    overlay.hidden = true;
    return;
  }

  overlay.hidden = false;
  overlay.dataset.severity = dialogError.severity || 'error';
  severityBadge.textContent = (dialogError.severity || 'error').toUpperCase();
  title.textContent = localizeField(dialogError.titleKey, dialogError.titleParams, dialogError.title)
    || t('dialogs:errorDialog.defaultTitle');
  code.textContent = dialogError.code
    ? t('dialogs:errorDialog.codePrefix', { code: dialogError.code })
    : t('dialogs:errorDialog.codePrefix', { code: t('dialogs:errorDialog.unknownCode') });
  message.textContent = localizeField(dialogError.messageKey, dialogError.messageParams, dialogError.message)
    || t('dialogs:errorDialog.defaultMessage');
  details.textContent = dialogError.details || t('dialogs:errorDialog.noDetails');

  const actionLabel = dialogError.suggestedAction === 'dismiss-error'
    ? ''
    : getActionLabel(dialogError.suggestedAction);
  primaryButton.hidden = !actionLabel;
  primaryButton.textContent = actionLabel;
}

function openErrorDialog(error) {
  if (!error) return;
  dialogError = error;
  dialogOpen = true;
  renderDialog();
}

function closeErrorDialog() {
  dialogOpen = false;
  dialogError = null;
  renderDialog();
}

async function copyErrorDetails() {
  if (!dialogError) return;

  try {
    await navigator.clipboard.writeText(formatErrorDetails(dialogError));
    showToast(t('toasts:error.copySuccess'), 'success', 1800);
  } catch (_) {
    showToast(t('toasts:error.copyFailed'), 'error');
  }
}

function initErrorDialog() {
  if (initialized) return;
  initialized = true;

  overlay?.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeErrorDialog();
    }
  });

  copyButton?.addEventListener('click', () => {
    copyErrorDetails();
  });

  closeButton?.addEventListener('click', () => {
    closeErrorDialog();
  });

  primaryButton?.addEventListener('click', async () => {
    if (!dialogError?.suggestedAction) return;

    const result = await performErrorAction(dialogError);
    if (result.shouldCloseDialog) {
      closeErrorDialog();
    }
  });

  subscribeErrorState((error) => {
    if (!error) {
      closeErrorDialog();
      return;
    }

    if (dialogOpen) {
      dialogError = error;
      renderDialog();
    }
  });

  // Re-render when the language changes so the already-open dialog
  // swaps its title/message/details live.
  window.addEventListener('app:language-changed', () => {
    if (dialogOpen) renderDialog();
  });
}

export {
  closeErrorDialog,
  initErrorDialog,
  openErrorDialog,
};
