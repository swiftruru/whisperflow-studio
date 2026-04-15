'use strict';

/**
 * "electron-updater" strategy.
 *
 * Used ONLY on Windows NSIS installed builds, because:
 *   - NSIS can download a new installer and run it on exit
 *   - Windows doesn't need code signing for auto-update to function
 *     (though SmartScreen will warn on the downloaded installer —
 *     that's a one-time user confirmation)
 *
 * macOS builds are unsigned, so we never use this strategy on
 * darwin.  Portable / AppImage / unknown platforms fall back to
 * strategy-manual-download.
 *
 * Why we don't use `autoUpdater.checkForUpdatesAndNotify()`
 * --------------------------------------------------------
 * That built-in helper shows an Electron-native notification toast
 * that doesn't match our theme, and it bypasses our "skip this
 * version" / "remind me later" logic.  Instead we:
 *
 *   1. Do our own check via `github-release-checker` (shared with
 *      macOS) to decide whether there's a newer version
 *   2. Only when the user actively chooses "Update now" do we call
 *      `autoUpdater.downloadUpdate()` — which streams download
 *      progress events that we forward to the renderer for the
 *      themed progress bar
 *   3. When `update-downloaded` fires, we broadcast a "ready"
 *      event so the renderer can change the button to "Install &
 *      restart", which calls back into `quitAndInstall()`
 *
 * This keeps ALL UI consistent with the rest of the app and gives
 * us control over every state transition.
 */

const { autoUpdater } = require('electron-updater');

const NAME = 'electron-updater';

let _broadcast = null;
let _downloadInProgress = false;
let _downloadReady = false;

function supportsAutoInstall() {
  return true;
}

/**
 * Wire autoUpdater events to the broadcast channel the updater
 * orchestrator passes in.  Called exactly once at app boot.
 *
 * @param {object} opts
 * @param {(channel: string, payload?: any) => void} opts.broadcast
 */
function setup({ broadcast }) {
  _broadcast = broadcast;

  // We never want electron-updater to auto-download behind the
  // user's back — that's the whole point of our explicit dialog.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Logger surface — electron-updater accepts any winston-ish
  // logger; `console` works fine in dev and the packaged build's
  // stdout goes to the system console on Windows.
  autoUpdater.logger = console;

  autoUpdater.on('download-progress', (progress) => {
    _broadcast('updater:download-progress', {
      percent: Math.round(progress.percent || 0),
      bytesPerSecond: progress.bytesPerSecond || 0,
      transferred: progress.transferred || 0,
      total: progress.total || 0,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    _downloadInProgress = false;
    _downloadReady = true;
    _broadcast('updater:download-done', {
      version: info?.version || '',
      releaseName: info?.releaseName || '',
    });
  });

  autoUpdater.on('error', (err) => {
    _downloadInProgress = false;
    _broadcast('updater:error', {
      message: err?.message || String(err),
      source: 'electron-updater',
    });
  });
}

/**
 * Called by the orchestrator when the user clicks "Update now".
 * Starts the actual download.  The `release` argument is the
 * normalised GitHub release we already fetched — electron-updater
 * will do its own parallel check and get the same version, which is
 * fine (two independent verifications of the same update).
 *
 * Returns immediately; download progress is delivered via the
 * `updater:download-progress` broadcast.
 */
async function start(/* release */) {
  if (_downloadInProgress) {
    // Second click on "Update now" while already downloading — no-op.
    return;
  }
  if (_downloadReady) {
    // User already downloaded; second click means "install now".
    installNow();
    return;
  }
  _downloadInProgress = true;
  try {
    // electron-updater needs to do its own checkForUpdates() before
    // downloadUpdate() will work, because it builds the internal
    // feed state from that check.  The result is cached so this
    // second network call is cheap.
    await autoUpdater.checkForUpdates();
    await autoUpdater.downloadUpdate();
  } catch (err) {
    _downloadInProgress = false;
    _broadcast('updater:error', {
      message: err?.message || String(err),
      source: 'electron-updater-download',
    });
  }
}

/**
 * Called when the user clicks "Restart & install now" after the
 * download has completed.  `quitAndInstall` kills the current
 * process, runs the NSIS installer, and relaunches.
 */
function installNow() {
  if (!_downloadReady) return;
  autoUpdater.quitAndInstall(false, true);
}

module.exports = {
  name: NAME,
  supportsAutoInstall,
  setup,
  start,
  installNow,
};
