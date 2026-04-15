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
 * Return the "key tail" — the part of a key after the last namespace
 * separator.  `settings:fields.pythonPath.description` → `fields.pythonPath.description`.
 * This is what i18next returns when a key is missing from its resources,
 * and we use it to detect and recover from missing-namespace situations.
 */
function _keyTail(key) {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/**
 * Synchronous translate.
 *
 * Defensive behaviour: if i18next returns the key (or the key tail)
 * — which happens when the namespace didn't load or the path is
 * missing — we fall back to `params.defaultValue` if provided, or to
 * an empty string.  This prevents users from ever seeing raw dot-path
 * strings like "fields.pythonPath.description" in the UI, even when
 * a JSON file fails to load (observed on some Windows builds where
 * a specific namespace file silently failed to parse).  Callers that
 * explicitly want the raw key on miss can pass `{ defaultValue: key }`.
 */
function t(key, params) {
  const defaultValue = params && typeof params.defaultValue === 'string'
    ? params.defaultValue
    : '';
  if (!_ready) return defaultValue || key;
  const result = i18next.t(key, params);
  if (typeof result !== 'string') return defaultValue;
  if (result === key || result === _keyTail(key)) {
    return defaultValue;
  }
  return result;
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
