'use strict';

/**
 * Custom application menu.
 *
 * Before this module the app used Electron's default menu, which is
 * fine for basic Edit/View/Window roles but has no entry point for
 * the update flow.  This module builds a template that:
 *
 *   1. On macOS, inserts a `Check for Updates…` item at the top of
 *      the app menu (right after "About"), matching what VS Code,
 *      Xcode, and every other Apple app does.
 *   2. On Windows / Linux, puts `Check for Updates…` under the
 *      Help menu (VS Code's convention there, since there's no
 *      "app menu" above File).
 *   3. Preserves every Electron built-in role (editMenu, viewMenu,
 *      windowMenu) so keyboard shortcuts like Cmd+Z, Cmd+W, DevTools
 *      toggle, etc. keep working — we don't want to regress the OS
 *      expectations.
 *
 * The menu labels are deliberately English-only.  Native OS menus
 * don't participate in the i18n data-attribute walker, and
 * rebuilding the menu on every language switch would double the
 * complexity.  VS Code and most major Electron apps also keep menu
 * labels fixed; if this ever becomes a problem we can add an
 * `app:language-changed`-triggered rebuild in a follow-up.
 */

const { Menu, app } = require('electron');

/**
 * Build and apply the application menu.
 *
 * @param {object} handlers
 * @param {() => void} handlers.onCheckForUpdates
 *     Called when the user clicks "Check for Updates…"
 * @param {() => void} handlers.onOpenAbout
 *     Called when the user clicks "About WhisperFlow Studio"; the
 *     main process asks the renderer to switch to the About tab.
 */
function setApplicationMenu({ onCheckForUpdates, onOpenAbout }) {
  const isMac = process.platform === 'darwin';

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    // macOS app menu — top-level, named after the app
    ...(isMac
      ? [{
        label: app.name,
        submenu: [
          {
            label: `About ${app.name}`,
            click: () => onOpenAbout?.(),
          },
          {
            label: 'Check for Updates…',
            click: () => onCheckForUpdates?.(),
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]
      : []),

    // File menu — only on non-mac (mac's app menu already has Quit)
    ...(isMac
      ? []
      : [{
        label: 'File',
        submenu: [
          { role: 'quit' },
        ],
      }]),

    // Preserve Electron's built-in Edit / View / Window roles so
    // DevTools toggle, undo/redo, zoom, etc. keep their keyboard
    // shortcuts.
    { role: 'editMenu' },
    { role: 'viewMenu' },
    ...(isMac ? [{ role: 'windowMenu' }] : []),

    {
      role: 'help',
      submenu: [
        ...(isMac
          ? []
          : [
            {
              label: 'Check for Updates…',
              click: () => onCheckForUpdates?.(),
            },
            { type: 'separator' },
            {
              label: 'About WhisperFlow Studio',
              click: () => onOpenAbout?.(),
            },
          ]),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

module.exports = { setApplicationMenu };
