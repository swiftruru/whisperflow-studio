'use strict';

/**
 * Platform strategy selector.
 *
 * Looks at `process.platform` and a few environment heuristics to
 * decide which update strategy this install should use.  Called
 * exactly once at boot by `initUpdater()`.
 *
 * Decision table:
 *
 *   | Platform         | Packaging          | Strategy             |
 *   |------------------|--------------------|----------------------|
 *   | darwin (macOS)   | DMG (unsigned)     | manual-download      |
 *   | win32            | NSIS installer     | electron-updater     |
 *   | win32            | portable exe       | manual-download      |
 *   | linux            | AppImage / other   | manual-download      |
 *   | other / unknown  | n/a                | manual-download      |
 *
 * Adding a new strategy (e.g. a real macOS auto-updater once
 * notarization is set up) only needs one new strategy file and one
 * extra branch here — nothing else in the updater module has to
 * change.
 */

const manualDownload = require('./strategy-manual-download');
const electronUpdater = require('./strategy-electron-updater');

/**
 * Best-effort detection of "is this a portable Windows build?"
 *
 * electron-builder's portable target sets `PORTABLE_EXECUTABLE_FILE`
 * in the environment when the app is launched from a portable exe,
 * so checking that env var is the cleanest signal.  We also treat
 * "Windows but NOT installed to Program Files" as a weak hint, but
 * trust the env var above all.
 */
function isPortableWindows() {
  if (process.platform !== 'win32') return false;
  if (process.env.PORTABLE_EXECUTABLE_FILE) return true;
  return false;
}

/**
 * Pick the strategy appropriate for this runtime.
 *
 * @returns {{
 *   name: string,
 *   supportsAutoInstall: () => boolean,
 *   setup: (opts: { broadcast: Function }) => void,
 *   start: (release: object) => Promise<void>,
 *   installNow?: () => void,
 * }}
 */
function pickStrategy() {
  if (process.platform === 'win32' && !isPortableWindows()) {
    return electronUpdater;
  }
  // darwin, win32 portable, linux, and unknown all fall through to
  // the manual-download strategy — safe and consistent.
  return manualDownload;
}

module.exports = {
  pickStrategy,
  isPortableWindows,
};
