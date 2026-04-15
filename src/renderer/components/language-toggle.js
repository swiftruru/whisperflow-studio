'use strict';

/**
 * Language toggle — binds ANY button element on the page that should
 * act as a zh-TW ↔ en switch.
 *
 * Originally this module only bound the titlebar toggle, but when the
 * help panel slides open it covers the titlebar and users lose access
 * to the language switch.  The fix is to expose the same behaviour on
 * a second button inside the help panel header, sharing the exact
 * same render / click handler so the two buttons can never drift out
 * of sync.
 *
 * The shared logic:
 *   - Renders a pill button showing `中 / EN` (the current language
 *     comes first, the one it'll flip to is second).
 *   - On click, calls `setLanguage()` which hits the i18n:set-language
 *     IPC.  Main process persists the choice and broadcasts back via
 *     i18n:language-changed.
 *   - Every bound button subscribes to `onLanguageChanged` so they
 *     all re-render whenever the language flips, regardless of which
 *     button was clicked.
 *
 * Two-language toggle instead of a dropdown is deliberate: for two
 * options a single tap is the fastest possible interaction, and
 * there's no ambiguity about what "flip" means.  If we ever add a
 * third language this module should grow into a popover.
 */

import { getCurrentLanguage, onLanguageChanged, setLanguage, t } from '../lib/i18n.js';

const LANGS = ['zh-TW', 'en'];
const LABELS = { 'zh-TW': '中', en: 'EN' };

// Every bound button is tracked so the onLanguageChanged subscription
// can re-render all of them (titlebar + help-panel, potentially more
// in the future).  The Set avoids double-binding the same element if
// `bindLanguageToggle()` gets called twice.
const boundButtons = new Set();
let globalListenerAttached = false;

function nextLang(current) {
  const idx = LANGS.indexOf(current);
  return LANGS[(idx + 1) % LANGS.length];
}

function render(button) {
  const current = getCurrentLanguage();
  const other = nextLang(current);
  button.textContent = `${LABELS[current]} / ${LABELS[other]}`;
  button.title = t('sidebar:titlebar.langToggleTip');
  button.setAttribute('aria-label', t('sidebar:titlebar.langToggleTip'));
  button.dataset.lang = current;
}

function renderAll() {
  for (const btn of boundButtons) {
    render(btn);
  }
}

/**
 * Attach the shared click handler + onLanguageChanged subscription to
 * a button element.  Idempotent: calling this twice on the same
 * element does nothing the second time.
 */
function bindLanguageToggle(button) {
  if (!button || boundButtons.has(button)) return;
  boundButtons.add(button);

  render(button);

  button.addEventListener('click', async () => {
    const current = getCurrentLanguage();
    const target = nextLang(current);
    // Disable ALL bound buttons during the round-trip so the user
    // can't double-click across both toggles.
    for (const b of boundButtons) b.disabled = true;
    try {
      await setLanguage(target);
    } finally {
      for (const b of boundButtons) b.disabled = false;
    }
    // renderAll() will also fire via the onLanguageChanged callback
    // once main echoes the change back.  Calling it here is harmless
    // and makes the UI feel instant on slow IPC links.
  });

  // Attach the global language-changed listener exactly once —
  // subsequent bindLanguageToggle() calls just add their buttons to
  // the Set and get picked up by the existing listener.
  if (!globalListenerAttached) {
    globalListenerAttached = true;
    onLanguageChanged(() => {
      renderAll();
    });
  }
}

/**
 * Bind the titlebar button — called at app init time.
 */
function initLanguageToggle() {
  const button = document.getElementById('btn-language-toggle');
  if (!button) return;
  bindLanguageToggle(button);
}

export { initLanguageToggle, bindLanguageToggle };
