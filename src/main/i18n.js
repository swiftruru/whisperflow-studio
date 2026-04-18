'use strict';

/**
 * Main-process i18n loader and runtime.
 *
 * Why main process needs its own i18next instance
 * -----------------------------------------------
 * The renderer has its own instance for DOM binding, but some strings
 * never leave the main process — Electron native dialogs
 * (`dialog.showMessageBox`), the BrowserWindow title, any future
 * menu/tray item.  Those can't use `data-i18n` attributes, so main
 * needs to be able to call `t(key)` directly.
 *
 * The two instances load the **same** JSON files from `locales/` so
 * there's a single source of truth for all translations.
 */

const fs = require('fs');
const path = require('path');
const i18next = require('i18next');

const SUPPORTED_LANGUAGES = ['zh-TW', 'en'];
const DEFAULT_LANGUAGE = 'zh-TW';
const FALLBACK_LANGUAGE = 'en';

const NAMESPACES = [
  'common',
  'sidebar',
  'preflight',
  'settings',
  'queue',
  'progress',
  'models',
  'console',
  'controls',
  'dialogs',
  'errors',
  'events',
  'toasts',
  'about',
  'help',
  'updater',
  'downloads',
  'changelog',
  'transcript',
];

/**
 * Resolve a user-facing language from a (possibly "auto") setting and
 * the OS locale reported by Electron's `app.getLocale()`.
 *
 *   resolveLanguage('zh-TW', 'en-US') === 'zh-TW'   // explicit override
 *   resolveLanguage('auto',  'zh-Hant-TW') === 'zh-TW'
 *   resolveLanguage('auto',  'ja-JP') === 'en'      // unknown → en
 *   resolveLanguage(null,    'zh-CN') === 'zh-TW'   // any zh-* → zh-TW
 */
function resolveLanguage(setting, osLocale) {
  if (typeof setting === 'string' && SUPPORTED_LANGUAGES.includes(setting)) {
    return setting;
  }
  const locale = typeof osLocale === 'string' ? osLocale.toLowerCase() : '';
  if (locale.startsWith('zh')) return 'zh-TW';
  if (locale.startsWith('en')) return 'en';
  // Any other system locale — fall back to zh-TW per product decision
  // (first-launch default is zh-TW when auto-detection can't match).
  return DEFAULT_LANGUAGE;
}

/**
 * Load every namespace JSON for both languages from disk.  Returns the
 * shape i18next expects: `{ 'zh-TW': { common: {...}, ... }, en: {...} }`.
 *
 * Any namespace that fails to load (missing file, parse error,
 * encoding issue, asar packaging glitch) is logged to stderr and
 * replaced with an empty object.  The renderer's `t()` wrapper then
 * falls back to HTML placeholder text so users never see raw key
 * paths — but the log line makes it obvious in the next bug report
 * which file was the culprit.  This defensive logging was added
 * after a Windows-specific regression where `settings.json` silently
 * failed to load but the rest of the namespaces were fine.
 */
function loadAllResources(localesRoot) {
  const resources = {};
  for (const lang of SUPPORTED_LANGUAGES) {
    resources[lang] = {};
    for (const ns of NAMESPACES) {
      const filePath = path.join(localesRoot, lang, `${ns}.json`);
      try {
        let content = fs.readFileSync(filePath, 'utf-8');
        // Strip UTF-8 BOM if present — `JSON.parse` chokes on BOM
        // and some Windows editors / git configs add one silently.
        if (content.charCodeAt(0) === 0xFEFF) {
          content = content.slice(1);
        }
        resources[lang][ns] = JSON.parse(content);
      } catch (err) {
        console.error(
          `[i18n] Failed to load ${lang}/${ns}.json: ${err.message} (path: ${filePath})`
        );
        resources[lang][ns] = {};
      }
    }
  }
  return resources;
}

let _initialized = false;
let _currentResources = null;
let _localesRoot = null;

/**
 * Initialize the main-process i18next instance.  Must be called from
 * `main.js` before any IPC handler or preflight check tries to emit a
 * user-facing string.
 *
 * @param {Object} options
 * @param {string} options.localesRoot    - absolute path to `locales/`
 * @param {string} options.initialLanguage - already-resolved language code
 */
async function initMainI18n({ localesRoot, initialLanguage }) {
  if (_initialized) {
    // Hot-reload path (shouldn't happen in prod, but guard anyway).
    await i18next.changeLanguage(initialLanguage);
    return i18next;
  }

  _localesRoot = localesRoot;
  _currentResources = loadAllResources(localesRoot);

  await i18next.init({
    lng: initialLanguage,
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    ns: NAMESPACES,
    defaultNS: 'common',
    nsSeparator: ':',
    keySeparator: '.',
    interpolation: {
      escapeValue: false,  // not rendering into HTML on the main side
    },
    resources: _currentResources,
    // Return key itself when translation missing — makes bugs visible
    // in UI without crashing.
    returnNull: false,
    returnEmptyString: false,
  });

  _initialized = true;
  return i18next;
}

/**
 * Main-process translate helper.  Same signature as i18next.t(), but
 * safe to call before init (returns the key as fallback so a stray
 * early call doesn't crash).
 */
function t(key, params) {
  if (!_initialized) return key;
  return i18next.t(key, params);
}

/**
 * Change main-process language and return the new resource snapshot.
 * Renderer receives the same snapshot via IPC so both sides stay in
 * sync without re-reading disk.
 */
async function setLanguage(lang) {
  const resolved = SUPPORTED_LANGUAGES.includes(lang) ? lang : FALLBACK_LANGUAGE;
  if (_initialized) {
    await i18next.changeLanguage(resolved);
  }
  return resolved;
}

function getCurrentLanguage() {
  return _initialized ? i18next.language : DEFAULT_LANGUAGE;
}

function getAllResources() {
  return _currentResources;
}

module.exports = {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  FALLBACK_LANGUAGE,
  NAMESPACES,
  resolveLanguage,
  initMainI18n,
  setLanguage,
  getCurrentLanguage,
  getAllResources,
  t,
};
