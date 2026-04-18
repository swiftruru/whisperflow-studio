'use strict';

/**
 * User-customizable keyboard shortcuts.
 *
 * Bindings are stored in localStorage as a JSON map `action → combo`
 * where combo is a "+"-joined list of modifiers and a key
 * (e.g. "CmdOrCtrl+R", "CmdOrCtrl+Shift+S", "CmdOrCtrl+.").
 *
 * Defaults mirror what was previously hardcoded in index.js; users can
 * override any entry via the Settings tab.  A per-action reset button
 * is exposed so people can always get back to the shipped defaults.
 */

const STORAGE_KEY = 'shortcuts.custom';

const DEFAULT_BINDINGS = Object.freeze({
  runTranscription: 'CmdOrCtrl+R',
  scanFiles: 'CmdOrCtrl+Shift+S',
  stopBatch: 'CmdOrCtrl+.',
  saveSettings: 'CmdOrCtrl+S',
  clearConsole: 'CmdOrCtrl+K',
  searchConsole: 'CmdOrCtrl+F',
});

const ACTION_ORDER = Object.keys(DEFAULT_BINDINGS);

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function getBindings() {
  const stored = readStored();
  const merged = { ...DEFAULT_BINDINGS };
  for (const action of ACTION_ORDER) {
    if (typeof stored[action] === 'string' && stored[action].trim()) {
      merged[action] = stored[action].trim();
    }
  }
  return merged;
}

function setBinding(action, combo) {
  if (!ACTION_ORDER.includes(action)) return false;
  const stored = readStored();
  if (combo === null || combo === undefined || combo === '') {
    delete stored[action];
  } else {
    stored[action] = combo;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch (_) {}
  return true;
}

function resetBinding(action) {
  setBinding(action, null);
}

/**
 * Build a canonical combo string from a KeyboardEvent.  Uses
 * "CmdOrCtrl" as the cross-platform modifier marker — matches
 * whichever of metaKey/ctrlKey is down on the current platform.
 */
function comboFromEvent(event) {
  if (!event) return '';
  const parts = [];
  const mod = event.metaKey || event.ctrlKey;
  if (mod) parts.push('CmdOrCtrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  let key = event.key;
  if (!key) return '';
  // Ignore pure-modifier events (Shift alone, etc.) — no main key yet.
  if (key === 'Control' || key === 'Meta' || key === 'Alt' || key === 'Shift') {
    return '';
  }
  // Normalize ".", "?" and letter casing so stored combos stay stable.
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

function eventMatchesCombo(event, combo) {
  if (!combo) return false;
  const expected = comboFromEvent(event);
  return expected === combo;
}

const ACTION_DISPATCHERS = {};

function registerShortcutAction(action, handler) {
  ACTION_DISPATCHERS[action] = handler;
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const bindings = getBindings();
    for (const [action, combo] of Object.entries(bindings)) {
      if (eventMatchesCombo(event, combo)) {
        // Save-settings only makes sense when the Settings tab is
        // visible — let the caller's handler short-circuit if wanted.
        if (isTyping && action !== 'searchConsole') {
          // Typing in a text field shouldn't hijack global shortcuts
          // that compete with common OS bindings.  `searchConsole`
          // (⌘F) is a deliberate exception — users expect it to
          // work from the search input itself.
          if (action === 'saveSettings') continue;
        }
        const handler = ACTION_DISPATCHERS[action];
        if (typeof handler === 'function') {
          event.preventDefault();
          handler(event);
          return;
        }
      }
    }
  });
}

export {
  DEFAULT_BINDINGS,
  ACTION_ORDER,
  getBindings,
  setBinding,
  resetBinding,
  comboFromEvent,
  eventMatchesCombo,
  registerShortcutAction,
  initKeyboardShortcuts,
};
