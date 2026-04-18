'use strict';

/**
 * Shortcuts settings panel — lets users rebind keyboard shortcuts.
 *
 * Click a binding to enter capture mode; the next keydown becomes the
 * new binding.  Pressing Esc cancels capture without saving; the "Reset"
 * button per-action (and the "Reset all" button) restore the shipped
 * defaults.
 */

import { t, onLanguageChanged } from '../lib/i18n.js';
import {
  ACTION_ORDER,
  DEFAULT_BINDINGS,
  getBindings,
  setBinding,
  resetBinding,
  comboFromEvent,
} from '../lib/shortcuts.js';
import { showToast } from './toast.js';

function prettyCombo(combo) {
  if (!combo) return t('settings:shortcuts.unbound');
  return combo
    .replace('CmdOrCtrl', navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl')
    .replace('Shift', '⇧')
    .replace('Alt', navigator.platform.toLowerCase().includes('mac') ? '⌥' : 'Alt');
}

function render() {
  const list = document.getElementById('settings-shortcuts-list');
  if (!list) return;
  list.innerHTML = '';

  const bindings = getBindings();

  for (const action of ACTION_ORDER) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'shortcut-row-label';
    labelEl.textContent = t(`settings:shortcuts.actions.${action}`);
    row.appendChild(labelEl);

    const bindBtn = document.createElement('button');
    bindBtn.type = 'button';
    bindBtn.className = 'shortcut-row-combo';
    bindBtn.textContent = prettyCombo(bindings[action]);
    bindBtn.dataset.action = action;
    bindBtn.addEventListener('click', () => startCapture(action, bindBtn));
    row.appendChild(bindBtn);

    if (bindings[action] !== DEFAULT_BINDINGS[action]) {
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'shortcut-row-reset';
      resetBtn.textContent = t('settings:shortcuts.reset');
      resetBtn.addEventListener('click', () => {
        resetBinding(action);
        render();
      });
      row.appendChild(resetBtn);
    }

    list.appendChild(row);
  }
}

function startCapture(action, bindBtn) {
  bindBtn.classList.add('capturing');
  bindBtn.textContent = t('settings:shortcuts.capturing');

  function cleanup() {
    document.removeEventListener('keydown', onKey, true);
    bindBtn.classList.remove('capturing');
  }

  function onKey(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      cleanup();
      render();
      return;
    }
    const combo = comboFromEvent(event);
    if (!combo) return; // pure modifier — wait for the real key
    setBinding(action, combo);
    cleanup();
    showToast(t('settings:shortcuts.bound', { action: t(`settings:shortcuts.actions.${action}`), combo: prettyCombo(combo) }), 'success', 2200);
    render();
  }

  // Capture phase so any other keydown listener (including the global
  // shortcuts module) doesn't fire while the user is rebinding.
  document.addEventListener('keydown', onKey, true);
}

function initShortcutsPanel() {
  if (!document.getElementById('settings-shortcuts-card')) return;
  render();
  document.getElementById('btn-shortcuts-reset-all')?.addEventListener('click', () => {
    for (const action of ACTION_ORDER) resetBinding(action);
    render();
    showToast(t('settings:shortcuts.resetAllToast'), 'info', 2000);
  });
  onLanguageChanged(() => render());
}

export { initShortcutsPanel };
