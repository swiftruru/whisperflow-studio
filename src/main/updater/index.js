'use strict';

/**
 * Updater orchestrator — the public face of the `updater/` module.
 *
 * Responsibilities
 * ----------------
 * 1. Pick the right platform strategy at boot (manual-download vs
 *    electron-updater) and call its `setup()` once.
 * 2. Expose `checkForUpdates({ manual })` that does the network call
 *    via `github-release-checker`, compares to `app.getVersion()`,
 *    honours the skip-state, and broadcasts the appropriate event
 *    for the renderer to react to.
 * 3. Expose `startUpdate()` / `skipVersion()` / `installNow()` —
 *    called by the renderer through IPC.
 * 4. Schedule the 5-second passive launch check.
 *
 * Everything platform-specific lives in the strategy files; this
 * orchestrator never touches `autoUpdater` or `shell.openExternal`
 * directly.
 *
 * Future work (tracked for follow-up PRs):
 *   - delta update support (electron-updater has it but needs NSIS
 *     `differentialPackage: true`)
 *   - beta channel opt-in (`settings.updater.channel: stable|beta`)
 *   - offline cache of last successful check so Windows-portable /
 *     mac users still see "last known latest" when offline
 *   - Linux AppImage strategy (`strategy-linux-appimage.js`)
 */

const { app } = require('electron');

const { LAUNCH_CHECK_DELAY_MS, GITHUB_RELEASES_PAGE_URL } = require('./config');
const { fetchLatestRelease } = require('./github-release-checker');
const { isNewerVersion } = require('./version-compare');
const {
  configureSkipState,
  getSkippedVersion,
  setSkippedVersion,
  shouldNotify,
} = require('./skip-state');
const { pickStrategy, isPortableWindows } = require('./platform-strategy');

let _strategy = null;
let _broadcast = null;
let _lastRelease = null;     // cached between check → start so the
                             // user's "Update now" click can re-use
                             // the same release info we already
                             // fetched for the modal
let _launchCheckTimer = null;

/**
 * Initialise the updater once at app boot.  Wires the platform
 * strategy, configures the skip-state helpers, and schedules the
 * passive 5-second launch check.
 *
 * @param {object} deps
 * @param {Function} deps.readSettings  - returns the merged settings.json contents
 * @param {Function} deps.writeSettings - writes merged settings.json
 * @param {(channel: string, payload?: object) => void} deps.broadcast
 *     sends an updater:* IPC event to every open BrowserWindow
 */
function initUpdater({ readSettings, writeSettings, broadcast }) {
  _broadcast = broadcast;
  configureSkipState({ readSettings, writeSettings });
  _strategy = pickStrategy();
  try {
    _strategy.setup({ broadcast });
  } catch (err) {
    console.error('[updater] strategy setup failed:', err);
  }

  // Schedule the passive launch check.  We intentionally use a
  // simple setTimeout instead of awaiting — we don't want to block
  // the rest of the init sequence, and the check should happen in
  // the background as far as the user is concerned.
  _launchCheckTimer = setTimeout(() => {
    checkForUpdates({ manual: false }).catch((err) => {
      // Launch-time errors are silent on purpose — the user didn't
      // ask to check, so surfacing an error toast would be noisy
      // (they might be offline, on a captive portal, etc.).
      console.error('[updater] passive check failed:', err?.message || err);
    });
  }, LAUNCH_CHECK_DELAY_MS);
}

/**
 * Cancel any pending passive check and reset internal state.  Used
 * on window close / app quit so we don't try to broadcast to a
 * destroyed window.
 */
function disposeUpdater() {
  if (_launchCheckTimer) {
    clearTimeout(_launchCheckTimer);
    _launchCheckTimer = null;
  }
}

/**
 * Check GitHub for a newer release.
 *
 * @param {object} opts
 * @param {boolean} [opts.manual=false]
 *     If true, the user explicitly triggered this check (menu or
 *     About button).  In that case we surface ALL states via
 *     broadcasts — checking, up-to-date, error — so the user sees
 *     feedback.  If false, the call is the passive launch check
 *     and we only broadcast when there's actually something new
 *     to show (silent otherwise).
 */
async function checkForUpdates({ manual = false } = {}) {
  // Always broadcast "checking" for manual triggers so the UI can
  // show a toast immediately — network calls can take a few seconds.
  if (manual) {
    _broadcast?.('updater:checking', { manual });
  }

  let release;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    if (manual) {
      _broadcast?.('updater:error', {
        message: err?.message || String(err),
        manual,
      });
    } else {
      console.error('[updater] passive check error (silent):', err?.message || err);
    }
    return;
  }

  _lastRelease = release;
  const current = app.getVersion();

  if (!isNewerVersion(release.version, current)) {
    // Already on the latest version.
    if (manual) {
      _broadcast?.('updater:up-to-date', { current });
    }
    return;
  }

  // A newer version exists.  Check skip-state for passive checks only
  // — manual checks always notify (user asked to see it).
  if (!manual && !shouldNotify(release.version)) {
    console.log(
      `[updater] passive check: v${release.version} available but user skipped this version, staying silent`
    );
    return;
  }

  // Broadcast the update-available event.  The renderer's
  // update-dialog component listens and opens the themed modal.
  _broadcast?.('updater:update-available', {
    manual,
    current,
    latest: release.version,
    tagName: release.tagName,
    name: release.name,
    body: release.body,
    notesPreview: release.notesPreview,
    htmlUrl: release.htmlUrl,
    publishedAt: release.publishedAt,
    strategy: _strategy?.name || 'manual-download',
    supportsAutoInstall: Boolean(_strategy?.supportsAutoInstall?.()),
    isPortableWindows: isPortableWindows(),
  });
}

/**
 * Trigger the platform-specific update flow.  Called from renderer
 * when the user clicks the "Update now" primary button.
 *
 * - manual-download strategy → opens the release page in browser
 * - electron-updater strategy → downloads the installer, then
 *   broadcasts download progress + `download-done`
 */
async function startUpdate() {
  if (!_strategy) {
    _broadcast?.('updater:error', {
      message: 'Updater not initialised',
      source: 'orchestrator',
    });
    return;
  }
  const release = _lastRelease;
  if (!release) {
    // User clicked "Update now" without a cached release — fetch
    // fresh and retry.  This shouldn't happen in the normal flow
    // because we always populate `_lastRelease` before showing the
    // modal, but defensive coding beats silent failure.
    try {
      _lastRelease = await fetchLatestRelease();
    } catch (err) {
      _broadcast?.('updater:error', {
        message: err?.message || String(err),
        source: 'orchestrator-refetch',
      });
      return;
    }
  }
  try {
    await _strategy.start(_lastRelease);
  } catch (err) {
    _broadcast?.('updater:error', {
      message: err?.message || String(err),
      source: 'strategy-start',
    });
  }
}

/**
 * Persist "skip this version" so we don't notify again until a
 * newer version appears.  Called from renderer.
 */
function skipVersion(version) {
  if (!version) return;
  setSkippedVersion(version);
  _broadcast?.('updater:skipped', { version });
}

/**
 * Called by the renderer when the user clicks "Restart & install
 * now" after an electron-updater download has completed.  Only
 * meaningful on Windows NSIS — on every other strategy this is a
 * no-op.
 */
function installNow() {
  if (_strategy?.installNow) {
    _strategy.installNow();
  }
}

/**
 * Accessor used by updater-ipc.js so the IPC handler can decide
 * whether to render the "Update now" button as "download + install"
 * (Windows) or "open release page" (mac / portable).
 */
function getStrategyInfo() {
  return {
    name: _strategy?.name || 'manual-download',
    supportsAutoInstall: Boolean(_strategy?.supportsAutoInstall?.()),
    isPortableWindows: isPortableWindows(),
    releasesPageUrl: GITHUB_RELEASES_PAGE_URL,
  };
}

module.exports = {
  initUpdater,
  disposeUpdater,
  checkForUpdates,
  startUpdate,
  skipVersion,
  installNow,
  getStrategyInfo,
  getSkippedVersion,
};
