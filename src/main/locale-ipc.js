'use strict';

/**
 * IPC bridge between the main-process i18n instance and the renderer.
 *
 * Channels
 * --------
 *  i18n:get-initial    — renderer asks for `{ lang, resources }` on boot,
 *                        uses it to construct its own mirror i18next
 *                        instance locally (no per-call round-trips).
 *  i18n:set-language   — renderer asks main to change language.  Main
 *                        persists the choice to settings.json and then
 *                        pushes `i18n:language-changed` back out so every
 *                        renderer tab stays consistent.
 *
 * Persistence is delegated to the same readLocalSettings/writeLocalSettings
 * pair that main.js already uses for `pythonPath` — no new storage layer.
 */

const { ipcMain, BrowserWindow } = require('electron');
const {
  SUPPORTED_LANGUAGES,
  setLanguage,
  getCurrentLanguage,
  getAllResources,
} = require('./i18n');

/**
 * @param {Object} deps
 * @param {() => Object} deps.readLocalSettings
 * @param {(data: Object) => void} deps.writeLocalSettings
 */
function registerLocaleIpcHandlers({ readLocalSettings, writeLocalSettings }) {
  ipcMain.handle('i18n:get-initial', () => ({
    lang: getCurrentLanguage(),
    supportedLanguages: SUPPORTED_LANGUAGES,
    resources: getAllResources(),
  }));

  ipcMain.handle('i18n:set-language', async (_event, requestedLang) => {
    const resolved = await setLanguage(requestedLang);

    // Persist: settings.json stores the user's *explicit* choice, not
    // the resolved language.  If the user picks "auto" we store "auto"
    // so future launches re-detect against OS locale.
    try {
      const settings = readLocalSettings() || {};
      const valueToStore = requestedLang === 'auto' ? 'auto' : resolved;
      settings.uiLanguage = valueToStore;
      writeLocalSettings(settings);
    } catch (err) {
      // Persistence failure shouldn't block the in-memory switch.
      console.error('[i18n] Failed to persist uiLanguage:', err);
    }

    // Broadcast to every open window so all renderers switch together.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('i18n:language-changed', resolved);
      }
    }

    return { ok: true, lang: resolved };
  });
}

module.exports = { registerLocaleIpcHandlers };
