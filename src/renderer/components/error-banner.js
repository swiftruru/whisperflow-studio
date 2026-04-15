'use strict';

import { clearActiveError, subscribeErrorState } from './error-state.js';
import { getActionLabel, performErrorAction } from './error-actions.js';
import { openErrorDialog } from './error-dialog.js';
import { t } from '../lib/i18n.js';

function localizeField(key, params, fallback) {
  if (key) return t(key, params || undefined);
  return fallback || '';
}

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
  title.textContent = localizeField(error.titleKey, error.titleParams, error.title)
    || t('dialogs:errorDialog.defaultTitle');
  message.textContent = localizeField(error.messageKey, error.messageParams, error.message)
    || t('dialogs:errorDialog.defaultMessage');
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

  // Re-render on language switch so an already-visible banner swaps
  // title/message without needing the user to re-trigger the error.
  window.addEventListener('app:language-changed', () => {
    if (currentError) render(currentError);
  });
}

export {
  initErrorBanner,
};
