'use strict';

/**
 * Lightweight wrapper around the GitHub Releases API.  One function:
 * `fetchLatestRelease()` returns a normalised shape for the rest of
 * the updater module to consume, so no other file has to know how
 * GitHub's JSON is laid out.
 *
 * We deliberately use anonymous requests (no PAT) — GitHub's
 * anonymous rate limit is 60 requests per hour per IP, which is
 * plenty for a desktop app that checks on launch + on manual trigger.
 */

const {
  GITHUB_LATEST_RELEASE_URL,
  GITHUB_RELEASES_PAGE_URL,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  RELEASE_NOTES_MAX_CHARS,
} = require('./config');

/**
 * @typedef {Object} NormalisedRelease
 * @property {string} tagName        - raw git tag, e.g. "v1.7.0"
 * @property {string} version         - sans leading `v`, e.g. "1.7.0"
 * @property {string} name            - release display name
 * @property {string} body            - raw markdown body
 * @property {string} notesPreview    - first N chars of body for UI
 * @property {string} htmlUrl         - release page on github.com
 * @property {string} publishedAt     - ISO timestamp
 * @property {boolean} prerelease
 * @property {Array<{name: string, browser_download_url: string, size: number}>} assets
 */

/**
 * Fetch the latest GitHub release for the configured repo.
 *
 * @returns {Promise<NormalisedRelease>}
 * @throws {Error} on network failure, HTTP error, or malformed response
 */
async function fetchLatestRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(GITHUB_LATEST_RELEASE_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        // Bypass any intermediate cache; release data changes rarely
        // but a cached stale response could prevent a real update
        // notification.
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw new Error(`Network error: ${err.message || err}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    // 403 from GH usually means anonymous rate limit exceeded.  Surface
    // that as a distinct message so users can figure out what's
    // happening; everything else collapses into "HTTP {status}".
    if (res.status === 403) {
      throw new Error('GitHub rate limit reached — please try again in an hour');
    }
    if (res.status === 404) {
      throw new Error('No release found');
    }
    throw new Error(`GitHub API HTTP ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Malformed GitHub response: ${err.message || err}`);
  }

  if (!data || typeof data.tag_name !== 'string') {
    throw new Error('GitHub response missing tag_name');
  }

  const tagName = data.tag_name;
  const version = tagName.replace(/^v/i, '');
  const body = typeof data.body === 'string' ? data.body : '';

  return {
    tagName,
    version,
    name: typeof data.name === 'string' ? data.name : tagName,
    body,
    notesPreview: truncateForPreview(body, RELEASE_NOTES_MAX_CHARS),
    htmlUrl: typeof data.html_url === 'string' ? data.html_url : GITHUB_RELEASES_PAGE_URL,
    publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
    prerelease: Boolean(data.prerelease),
    assets: Array.isArray(data.assets) ? data.assets.map(stripAsset) : [],
  };
}

function stripAsset(a) {
  return {
    name: a && a.name ? String(a.name) : '',
    browser_download_url: a && a.browser_download_url ? String(a.browser_download_url) : '',
    size: typeof a?.size === 'number' ? a.size : 0,
  };
}

/**
 * Strip raw markdown down to something presentable as plain text
 * without pulling in a markdown parser.
 *
 * - Drop leading `##` / `###` headings (keep their text)
 * - Collapse consecutive blank lines
 * - Trim to N chars with an ellipsis
 */
function truncateForPreview(body, max) {
  if (!body) return '';
  const cleaned = body
    .replace(/^#{1,6}\s+/gm, '')           // drop heading markers
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1') // strip code fences / inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // strip bold
    .replace(/__([^_]+)__/g, '$1')         // strip bold (alt)
    .replace(/\*([^*]+)\*/g, '$1')         // strip italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/\n{3,}/g, '\n\n')            // collapse blank lines
    .trim();

  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1).trimEnd() + '…';
}

module.exports = {
  fetchLatestRelease,
  truncateForPreview,
};
