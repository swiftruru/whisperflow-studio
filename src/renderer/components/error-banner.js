'use strict';

import { clearActiveError, subscribeErrorState } from './error-state.js';
import { getActionLabel, performErrorAction } from './error-actions.js';
import { openErrorDialog } from './error-dialog.js';

const banner = document.getElementById('error-banner');
const badge = document.getElementById('error-banner-badge');
const title = document.getElementById('error-banner-title');
const message = document.getElementById('error-banner-message');
const code = document.getElementById('error-banner-code');
const primaryButton = document.getElementById('btn-error-banner-action');
const detailsButton = document.getElementById('btn-error-banner-details');
const dismissButton = document.getElementById('btn-error-banner-dismiss');

let currentError = null;
let initialized = false;

function render(error) {
  currentError = error;

  if (!error) {
    banner.hidden = true;
    banner.dataset.severity = 'error';
    return;
  }

  banner.hidden = false;
  banner.dataset.severity = error.severity || 'error';
  badge.textContent = (error.severity || 'error').toUpperCase();
  title.textContent = error.title || '執行失敗';
  message.textContent = error.message || '發生未預期錯誤。';
  code.textContent = error.code ? `Code: ${error.code}` : '';
  code.hidden = !error.code;

  const actionLabel = error.suggestedAction === 'dismiss-error'
    ? ''
    : getActionLabel(error.suggestedAction);
  primaryButton.hidden = !actionLabel;
  primaryButton.textContent = actionLabel;
  detailsButton.hidden = !(error.code || error.details || error.message);
}

async function handlePrimaryAction() {
  if (!currentError?.suggestedAction) return;
  await performErrorAction(currentError);
}

function initErrorBanner() {
  if (initialized) return;
  initialized = true;

  primaryButton?.addEventListener('click', () => {
    handlePrimaryAction();
  });

  detailsButton?.addEventListener('click', () => {
    if (!currentError) return;
    openErrorDialog(currentError);
  });

  dismissButton?.addEventListener('click', () => {
    clearActiveError();
  });

  subscribeErrorState(render);
}

export {
  initErrorBanner,
};
