'use strict';

/**
 * Titlebar language toggle.
 *
 * Renders a small pill button in the titlebar right-cluster that
 * flips between zh-TW ↔ en.  Uses the current language from the
 * renderer's i18next instance to decide the label; clicking asks
 * main to switch via the `i18n:set-language` IPC, and main
 * broadcasts back so every renderer (and main-process dialog) stays
 * in sync.
 *
 * Two-language toggle instead of a dropdown:
 *   - Fastest click for the common case (flip the only other choice)
 *   - Dropdown adds visual clutter to a titlebar that already hosts
 *     theme toggle + status badge + Setup button + window controls
 *   - If we ever add a third language this module should turn into
 *     a small popover instead of a hard switch
 */

import { getCurrentLanguage, onLanguageChanged, setLanguage, t } from '../lib/i18n.js';

const LANGS = ['zh-TW', 'en'];
const LABELS = { 'zh-TW': '中', en: 'EN' };

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

function initLanguageToggle() {
  const button = document.getElementById('btn-language-toggle');
  if (!button) return;

  render(button);

  button.addEventListener('click', async () => {
    const current = getCurrentLanguage();
    const target = nextLang(current);
    button.disabled = true;
    try {
      await setLanguage(target);
    } finally {
      button.disabled = false;
    }
    // render() will re-run via the onLanguageChanged callback below
    // once main echoes the change back, so we don't need to touch the
    // button here.
  });

  onLanguageChanged(() => {
    render(button);
  });
}

export { initLanguageToggle };
