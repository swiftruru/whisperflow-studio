'use strict';

/**
 * Renderer-side i18n runtime.
 *
 * The renderer keeps its own i18next instance (mirroring main) so that
 * `t()` is synchronous and doesn't need an IPC round-trip per call —
 * essential when a component renders hundreds of DOM nodes.
 *
 * Main remains the source of truth: we call `i18n:get-initial` once at
 * boot, seed i18next with those resources, then listen for
 * `i18n:language-changed` to swap languages later.
 *
 * Exports
 * -------
 *  initRendererI18n()   — must be awaited before any component calls t()
 *  t(key, params)       — same signature as i18next.t()
 *  getCurrentLanguage() — current resolved language code
 *  onLanguageChanged(cb)— subscribe to language change events
 */

import i18next from '../../../node_modules/i18next/dist/esm/i18next.js';

let _ready = false;
let _readyPromise = null;
let _listeners = new Set();

async function initRendererI18n() {
  if (_ready) return;
  if (_readyPromise) return _readyPromise;

  _readyPromise = (async () => {
    const { lang, resources, supportedLanguages } = await window.electronAPI.i18n.getInitial();

    await i18next.init({
      lng: lang,
      fallbackLng: 'en',
      supportedLngs: supportedLanguages || ['zh-TW', 'en'],
      ns: Object.keys(resources[lang] || { common: {} }),
      defaultNS: 'common',
      nsSeparator: ':',
      keySeparator: '.',
      interpolation: { escapeValue: false },
      resources,
      returnNull: false,
      returnEmptyString: false,
    });

    // The main process broadcasts 'i18n:language-changed' whenever the
    // user flips the toggle.  Mirror the change here and notify every
    // component that subscribed via onLanguageChanged().
    window.electronAPI.i18n.onLanguageChanged(async (newLang) => {
      await i18next.changeLanguage(newLang);
      document.documentElement.lang = newLang;
      for (const listener of _listeners) {
        try {
          listener(newLang);
        } catch (err) {
          console.error('[i18n] listener failed:', err);
        }
      }
      // Dispatch a DOM event too — easier for modules that'd rather
      // listen via addEventListener than import this module.
      window.dispatchEvent(new CustomEvent('app:language-changed', { detail: newLang }));
    });

    document.documentElement.lang = lang;
    _ready = true;
  })();

  return _readyPromise;
}

/**
 * Synchronous translate.  Safe to call before init returns: falls back
 * to the key itself so static DOM that renders pre-boot doesn't break.
 */
function t(key, params) {
  if (!_ready) return key;
  return i18next.t(key, params);
}

function getCurrentLanguage() {
  return _ready ? i18next.language : 'zh-TW';
}

function onLanguageChanged(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

async function setLanguage(lang) {
  return window.electronAPI.i18n.setLanguage(lang);
}

export {
  initRendererI18n,
  t,
  getCurrentLanguage,
  onLanguageChanged,
  setLanguage,
};
