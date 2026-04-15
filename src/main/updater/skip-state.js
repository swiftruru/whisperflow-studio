'use strict';

/**
 * Persist the "skip this version" user preference to settings.json.
 *
 * This module is a thin wrapper over the existing readLocalSettings
 * / writeLocalSettings helpers already in use by main.js — we do NOT
 * touch the filesystem directly, so the normal merge / default-fill
 * behaviour in `normalizeLocalSettings` applies to our keys too.
 *
 * Storage shape:
 *   settings.json
 *   └── updater
 *       └── skippedVersion: "1.7.0" | null
 *
 * Semantic rules:
 *   - `null` means no version has been skipped → notify on every check
 *   - Any string means "ignore this exact version".  If a newer
 *     version appears later, the `shouldNotify()` helper correctly
 *     re-surfaces the notification — users don't get stuck on the
 *     old skip state forever.
 */

const { isNewerVersion } = require('./version-compare');

let _readSettings = null;
let _writeSettings = null;

/**
 * Injected during `initUpdater()` — avoids the skip-state module
 * depending directly on main.js's local settings helpers and keeps
 * this file unit-testable by stubbing the two functions.
 */
function configureSkipState({ readSettings, writeSettings }) {
  _readSettings = readSettings;
  _writeSettings = writeSettings;
}

function _assertConfigured() {
  if (!_readSettings || !_writeSettings) {
    throw new Error('[updater/skip-state] not configured — call configureSkipState() first');
  }
}

function getSkippedVersion() {
  _assertConfigured();
  try {
    const settings = _readSettings() || {};
    return settings.updater?.skippedVersion || null;
  } catch (err) {
    console.error('[updater/skip-state] Failed to read settings:', err);
    return null;
  }
}

function setSkippedVersion(version) {
  _assertConfigured();
  try {
    const settings = _readSettings() || {};
    const merged = {
      ...settings,
      updater: {
        ...(settings.updater || {}),
        skippedVersion: version || null,
      },
    };
    _writeSettings(merged);
  } catch (err) {
    console.error('[updater/skip-state] Failed to persist skippedVersion:', err);
  }
}

function clearSkippedVersion() {
  setSkippedVersion(null);
}

/**
 * Decide whether we should surface an "update available" notification
 * for a given latest version, given the currently-stored skip state.
 *
 * - No skip stored → always notify
 * - Latest version is strictly newer than the skipped version →
 *   notify (the user only skipped that specific older version)
 * - Latest version equals the skipped version → suppress
 *
 * @param {string} latestVersion
 * @returns {boolean}
 */
function shouldNotify(latestVersion) {
  const skipped = getSkippedVersion();
  if (!skipped) return true;
  return isNewerVersion(latestVersion, skipped);
}

module.exports = {
  configureSkipState,
  getSkippedVersion,
  setSkippedVersion,
  clearSkippedVersion,
  shouldNotify,
};
