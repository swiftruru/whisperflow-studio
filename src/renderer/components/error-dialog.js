'use strict';

import { subscribeErrorState } from './error-state.js';
import { getActionLabel, performErrorAction } from './error-actions.js';
import { showToast } from './toast.js';

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
  title.textContent = dialogError.title || '執行失敗';
  code.textContent = dialogError.code ? `Error code: ${dialogError.code}` : 'Error code: UNKNOWN_RUNTIME_ERROR';
  message.textContent = dialogError.message || '發生未預期錯誤。';
  details.textContent = dialogError.details || '沒有額外技術細節。';

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
    showToast('錯誤資訊已複製', 'success', 1800);
  } catch (_) {
    showToast('無法複製錯誤資訊', 'error');
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
}

export {
  closeErrorDialog,
  initErrorDialog,
  openErrorDialog,
};
