'use strict';

/**
 * Show a transient toast in the bottom-right container.
 *
 * @param {string} message
 * @param {'success'|'info'|'error'} [type='success']
 * @param {number} [duration=3000] milliseconds before auto-dismiss
 * @param {Object} [options]
 * @param {Object} [options.action] optional inline action button
 * @param {string} [options.action.label]
 * @param {Function} [options.action.onClick]
 */
export function showToast(message, type = 'success', duration = 3000, options = {}) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;

  const msgEl = document.createElement('span');
  msgEl.className = 'toast-message';
  msgEl.textContent = message;
  el.appendChild(msgEl);

  if (options?.action?.label && typeof options.action.onClick === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'toast-action';
    actionBtn.textContent = options.action.label;
    actionBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      try { options.action.onClick(event); } catch (_) { /* swallow */ }
      // Dismiss the toast after the action fires so it doesn't hang
      // around once the user has acted on it.
      el.classList.remove('show');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    });
    el.appendChild(actionBtn);
  }

  container.appendChild(el);
  // Trigger animation on next frame
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, duration);
}
