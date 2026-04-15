'use strict';

import { t } from './i18n.js';

// Themed replacement for the browser's blocking `window.confirm()`.
// Returns a Promise<boolean>: resolves to `true` if the user clicks the
// confirm button, `false` if they cancel, hit Escape, or click the
// backdrop.  Reuses the existing `.modal-overlay` / `.modal` styles so
// it inherits the app's pastel-cream theme automatically.
//
// Default button labels come from the `dialogs:confirm.*` i18n namespace
// so every caller that omits them still gets a localized UI.  Pass
// explicit confirmText/cancelText when the context wants a verb other
// than the generic "Confirm / Cancel" (e.g. "Delete" for destructive
// actions — see model-manager.js:handleDelete).

/**
 * @typedef {Object} ConfirmDialogOptions
 * @property {string} title       - Bold heading
 * @property {string} [message]   - Body text (plain string)
 * @property {string} [confirmText='確定']
 * @property {string} [cancelText='取消']
 * @property {boolean} [destructive=false] - Style the confirm button as a danger action
 */

/**
 * @param {ConfirmDialogOptions} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title,
  message = '',
  confirmText,
  cancelText,
  destructive = false,
} = {}) {
  const resolvedConfirm = confirmText || t('dialogs:confirm.confirmLabel');
  const resolvedCancel = cancelText || t('dialogs:confirm.cancelLabel');
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = `modal confirm-dialog${destructive ? ' confirm-dialog--destructive' : ''}`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h2');
    heading.textContent = title;
    modal.appendChild(heading);

    if (message) {
      const body = document.createElement('p');
      body.className = 'confirm-dialog-message';
      body.textContent = message;
      modal.appendChild(body);
    }

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary confirm-dialog-btn';
    cancelBtn.textContent = resolvedCancel;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = destructive
      ? 'btn-primary confirm-dialog-btn confirm-dialog-btn--danger'
      : 'btn-primary confirm-dialog-btn';
    confirmBtn.textContent = resolvedConfirm;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);

    function cleanup(value) {
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(value);
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        cleanup(true);
      }
    }

    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (event) => {
      // Click outside the modal box closes as cancel.
      if (event.target === overlay) cleanup(false);
    });

    document.addEventListener('keydown', onKeyDown, true);

    document.body.appendChild(overlay);

    // Focus the confirm button so Enter/Space immediately confirms.  We
    // schedule it on the next frame so the modal has had a chance to mount.
    requestAnimationFrame(() => {
      confirmBtn.focus();
    });
  });
}
