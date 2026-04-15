'use strict';

/**
 * Tiny semver comparator.  Only covers the X.Y.Z / vX.Y.Z format
 * WhisperFlow Studio actually uses — no pre-release, no build
 * metadata.  Avoids pulling in the `semver` package as a runtime
 * dependency just for one comparison.
 *
 * Edge cases handled:
 *   - Leading `v` prefix is stripped (`v1.2.3` === `1.2.3`)
 *   - Missing segments default to 0 (`1.2` → [1, 2, 0])
 *   - Non-numeric segments default to 0 (`1.2.foo` → [1, 2, 0])
 *
 * If we ever start shipping `1.7.0-beta.1` pre-releases we'll need
 * to switch to the real `semver` package, but for the stable-only
 * release cadence this is fine.
 */

function parseVersion(value) {
  if (typeof value !== 'string') return [0, 0, 0];
  const clean = value.trim().replace(/^v/i, '');
  const parts = clean.split('.').slice(0, 3).map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts;
}

/**
 * @param {string} candidate version tag being tested
 * @param {string} base version to compare against (usually app.getVersion())
 * @returns {boolean} true iff `candidate` is strictly newer than `base`
 */
function isNewerVersion(candidate, base) {
  const [a, b, c] = parseVersion(candidate);
  const [x, y, z] = parseVersion(base);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c > z;
}

/** @returns {number} -1 / 0 / 1 like `String.localeCompare` */
function compareVersions(a, b) {
  const [a1, a2, a3] = parseVersion(a);
  const [b1, b2, b3] = parseVersion(b);
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return 0;
}

module.exports = {
  parseVersion,
  isNewerVersion,
  compareVersions,
};
