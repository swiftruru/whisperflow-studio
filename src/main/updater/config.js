'use strict';

/**
 * Centralised constants for the updater module.
 *
 * Everything that needs to be tweaked for a repo fork or a mirror
 * source lives here so the rest of the updater never hard-codes a
 * URL or identifier.
 */

const REPO_OWNER = 'swiftruru';
const REPO_NAME = 'whisperflow-studio';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_LATEST_RELEASE_URL =
  `${GITHUB_API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const GITHUB_RELEASES_PAGE_URL =
  `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

/**
 * How long after window creation we wait before running the passive
 * launch-time check.  Short enough to still feel "on launch" but long
 * enough that the preflight panel has a chance to resolve first and
 * we're not competing for CPU during the busiest moment of boot.
 */
const LAUNCH_CHECK_DELAY_MS = 5000;

/**
 * Network timeout for GitHub API requests.  The GH API is usually
 * sub-second; anything over 10 seconds probably means the user is
 * offline or GitHub is rate-limiting us.
 */
const REQUEST_TIMEOUT_MS = 10000;

const USER_AGENT = 'WhisperFlow-Studio-Updater';

/**
 * Release notes shown in the update dialog are truncated to this
 * many characters to keep the modal a reasonable size.  The full
 * notes live behind a "View full release notes" link that opens the
 * GitHub release page.
 */
const RELEASE_NOTES_MAX_CHARS = 600;

module.exports = {
  REPO_OWNER,
  REPO_NAME,
  GITHUB_API_BASE,
  GITHUB_LATEST_RELEASE_URL,
  GITHUB_RELEASES_PAGE_URL,
  LAUNCH_CHECK_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  RELEASE_NOTES_MAX_CHARS,
};
