'use strict';

/**
 * Tray / menubar integration — optional, opt-out via settings.json.
 *
 * macOS uses the existing icon (treated as non-template for visibility);
 * Windows/Linux use the same PNG from the assets folder.  Tray is
 * always created in-app regardless of platform, but on Linux some DEs
 * don't show tray icons at all; that's a quiet no-op.
 *
 * Global shortcuts:
 *   - CmdOrCtrl+Alt+T — show / focus the main window
 *   - CmdOrCtrl+Alt+R — start a run (same as clicking the Run button)
 *
 * The renderer reacts via a `tray:action` IPC broadcast so this module
 * doesn't need to know anything about queue state.
 */

const path = require('path');
const { Tray, Menu, nativeImage, globalShortcut, app } = require('electron');

const SHORTCUT_SHOW = 'CommandOrControl+Alt+T';
const SHORTCUT_RUN = 'CommandOrControl+Alt+R';

let tray = null;

function showWindow(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function broadcast(mainWindow, action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tray:action', action);
}

function buildMenu(mainWindow, tFn) {
  return Menu.buildFromTemplate([
    { label: tFn('common:app.show'), click: () => showWindow(mainWindow) },
    { type: 'separator' },
    { label: tFn('common:app.runTranscription'), click: () => { showWindow(mainWindow); broadcast(mainWindow, 'run'); } },
    { label: tFn('common:app.scan'), click: () => { showWindow(mainWindow); broadcast(mainWindow, 'scan'); } },
    { label: tFn('common:app.stop'), click: () => broadcast(mainWindow, 'stop') },
    { type: 'separator' },
    { label: tFn('common:app.quit'), role: 'quit' },
  ]);
}

function initTray({ mainWindow, electronAppRoot, t: tFn }) {
  // Find an icon — prefer template-ish for macOS menubar.
  const iconCandidates = [
    path.join(electronAppRoot, 'assets', 'tray-icon.png'),
    path.join(electronAppRoot, 'assets', 'icon-mac.png'),
    path.join(electronAppRoot, 'assets', 'icon.png'),
  ];
  let iconPath = null;
  for (const candidate of iconCandidates) {
    try {
      const img = nativeImage.createFromPath(candidate);
      if (!img.isEmpty()) {
        iconPath = candidate;
        break;
      }
    } catch (_) { /* try next */ }
  }
  if (!iconPath) return null;

  try {
    const img = nativeImage.createFromPath(iconPath);
    const resized = img.resize({ width: 18, height: 18 });
    tray = new Tray(resized);
    tray.setToolTip(app.getName());
    tray.setContextMenu(buildMenu(mainWindow, tFn));
    tray.on('click', () => showWindow(mainWindow));
  } catch (err) {
    console.error('[tray] failed to create tray:', err.message);
    return null;
  }

  // Global shortcuts.  registerOK check prevents silent overwrites of
  // whatever else already grabs the combo — we just warn in that case.
  try {
    const okShow = globalShortcut.register(SHORTCUT_SHOW, () => showWindow(mainWindow));
    const okRun = globalShortcut.register(SHORTCUT_RUN, () => {
      showWindow(mainWindow);
      broadcast(mainWindow, 'run');
    });
    if (!okShow) console.warn(`[tray] ${SHORTCUT_SHOW} is already registered by another app`);
    if (!okRun) console.warn(`[tray] ${SHORTCUT_RUN} is already registered by another app`);
  } catch (err) {
    console.error('[tray] globalShortcut.register failed:', err.message);
  }

  // Refresh the menu when language changes so labels follow the user's
  // preference without an app restart.
  return {
    refresh: () => {
      if (!tray || tray.isDestroyed()) return;
      tray.setContextMenu(buildMenu(mainWindow, tFn));
    },
    destroy: () => {
      try { globalShortcut.unregisterAll(); } catch (_) {}
      if (tray && !tray.isDestroyed()) tray.destroy();
      tray = null;
    },
  };
}

module.exports = { initTray };
