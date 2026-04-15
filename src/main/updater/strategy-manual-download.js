'use strict';

/**
 * "Manual download" update strategy.
 *
 * Used on:
 *   - macOS — we're unsigned and can't safely auto-install
 *   - Windows portable — can't overwrite its own exe while running
 *   - Linux — future AppImage auto-update is a separate strategy
 *   - Any platform we don't explicitly recognise
 *
 * This strategy never downloads anything itself.  It just opens the
 * GitHub release page in the user's default browser and lets them
 * download the right asset for their machine.  The `start()` method
 * is a promise so the orchestrator can await it and surface an
 * `openPageFailed` toast if `shell.openExternal` refuses the URL
 * (which shouldn't happen for https:// URLs, but defensive coding
 * beats cryptic silence).
 */

const { shell } = require('electron');
const { GITHUB_RELEASES_PAGE_URL } = require('./config');

const NAME = 'manual-download';

/**
 * Returns whether this strategy does real auto-install (false here
 * — used by the update dialog to decide whether to show a progress
 * bar or just a "go to page" button).
 */
function supportsAutoInstall() {
  return false;
}

/**
 * Kick off the update flow.  For manual-download that just means
 * opening the release page.
 *
 * @param {object} release normalised release object from github-release-checker
 * @returns {Promise<void>}
 * @throws {Error} if the browser refused to open
 */
async function start(release) {
  const url = (release && release.htmlUrl) || GITHUB_RELEASES_PAGE_URL;
  await shell.openExternal(url);
}

/**
 * Manual strategy has no background state to set up — no listeners,
 * no autoUpdater instance.  This is a no-op on purpose.
 */
function setup() {
  // Intentionally empty.
}

module.exports = {
  name: NAME,
  supportsAutoInstall,
  setup,
  start,
};
