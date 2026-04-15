'use strict';

/**
 * IPC bridge between the updater orchestrator and the renderer.
 *
 * Channels
 * --------
 *  updater:check           (invoke) — manual check request from renderer
 *  updater:skip            (invoke) — persist "skip this version"
 *  updater:install         (invoke) — trigger quitAndInstall (Windows NSIS)
 *  updater:get-strategy    (invoke) — ask main for current strategy info
 *
 *  updater:checking          (broadcast) — fired when a manual check starts
 *  updater:update-available  (broadcast) — new version found + release info
 *  updater:up-to-date        (broadcast) — manual check confirmed latest
 *  updater:error             (broadcast) — network / API / install error
 *  updater:download-progress (broadcast) — Windows NSIS download % tick
 *  updater:download-done     (broadcast) — installer ready, waiting for restart
 *  updater:skipped           (broadcast) — user chose "Skip this version"
 *
 * The orchestrator uses the `broadcast()` helper returned from this
 * module for all outgoing events, so IPC channel names live in
 * exactly one place.
 */

const { ipcMain, BrowserWindow } = require('electron');
const updater = require('./index');

/**
 * Broadcast an updater event to every open window.  Called from
 * the orchestrator.  If there are no open windows (shouldn't happen
 * in the normal launch flow but can during quit races), the event
 * is silently dropped.
 */
function broadcastUpdaterEvent(channel, payload = {}) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      console.error(`[updater-ipc] broadcast ${channel} failed:`, err);
    }
  }
}

/**
 * Register all updater:* IPC handlers on the main process side.
 * Must be called once after `ipcMain` is ready (same phase as the
 * other ipcMain.handle registrations in ipc-handlers.js).
 */
function registerUpdaterIpcHandlers() {
  ipcMain.handle('updater:check', async (_event, opts = {}) => {
    const manual = Boolean(opts && opts.manual);
    try {
      await updater.checkForUpdates({ manual });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('updater:skip', async (_event, version) => {
    updater.skipVersion(version);
    return { ok: true };
  });

  // Kick off the platform-specific update action.  On Windows NSIS
  // this starts `autoUpdater.downloadUpdate()`; on macOS / portable
  // this opens the GitHub release page via `shell.openExternal`.
  // Either way the renderer just awaits the promise.
  ipcMain.handle('updater:start', async () => {
    try {
      await updater.startUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Called only after the Windows NSIS download is complete, when
  // the user clicks "Restart & install now".
  ipcMain.handle('updater:install', async () => {
    updater.installNow();
    return { ok: true };
  });

  ipcMain.handle('updater:get-strategy', async () => {
    return updater.getStrategyInfo();
  });
}

module.exports = {
  broadcastUpdaterEvent,
  registerUpdaterIpcHandlers,
};
