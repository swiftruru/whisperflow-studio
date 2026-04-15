'use strict';

/**
 * Shared helpers for managing the main process's `process.env.PATH`.
 *
 * Two concerns live here:
 *
 * 1. `applyExtraPathPrefixes(prefixes)` — prepends the platform-
 *    appropriate install locations from `config.metadata.json ::
 *    appRuntime.extraPathPrefixes` to the current PATH.  GUI apps
 *    on macOS / Windows / Linux inherit a minimal PATH from their
 *    launcher (Finder / Explorer / desktop entry) that usually only
 *    contains the system defaults, so tools the user installed via
 *    Homebrew / Scoop / winget / apt / etc. are invisible unless we
 *    re-add their bin directories manually.  Called once at boot
 *    from `main.js` and can be called again after any operation
 *    that might have added new install locations (e.g., winget
 *    dropping a new shim dir into the User PATH).
 *
 * 2. `refreshSystemPathFromRegistry()` — Windows-only.  After a
 *    package-manager install, the new binary is often in a directory
 *    that winget / Scoop added to the **User PATH** via a registry
 *    write.  Because `process.env.PATH` was captured at boot time,
 *    the Electron main process never sees that new entry until the
 *    app is restarted — which is how `winget install ffmpeg` can
 *    report "已成功安裝" and the Links directory gets registered,
 *    but our preflight keeps saying "not found".  This helper re-
 *    reads the current `HKCU\Environment\Path` and
 *    `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path`
 *    via `reg.exe` (always present on Windows, no PowerShell
 *    dependency), merges them with whatever prefixes we added at
 *    boot, and writes the result back to `process.env.PATH`.  On
 *    macOS / Linux it's a no-op.
 */

const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * Remember the extraPathPrefixes we applied at boot so any later
 * registry refresh can re-prepend them to the fresh PATH without
 * needing main.js to thread them through.
 * @type {string[]}
 */
let _cachedExtraPrefixes = [];

/**
 * Apply platform-appropriate extra PATH prefixes.  Idempotent — the
 * same prefix won't be added twice even on repeat calls.
 *
 * @param {string[]} prefixes - raw prefix strings from config.metadata.json
 */
function applyExtraPathPrefixes(prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return;
  const expanded = prefixes.map((p) =>
    typeof p === 'string' ? p.replace(/\$\{HOME\}/g, os.homedir()) : p,
  );
  _cachedExtraPrefixes = expanded;
  const current = (process.env.PATH || '').split(path.delimiter);
  const merged = [...new Set([...expanded, ...current])].join(path.delimiter);
  process.env.PATH = merged;
}

/**
 * Expand Windows-style `%VAR%` references inside a string using the
 * current process.env.  Unknown variables are left in place — we'd
 * rather pass through a literal `%FOO%` to downstream code than
 * silently drop a PATH segment.
 */
function expandWindowsEnvVars(input) {
  if (typeof input !== 'string' || !input) return input;
  return input.replace(/%([^%]+)%/g, (match, name) => {
    // process.env is case-insensitive on Windows via Node's internal
    // handling, so a direct lookup works for %USERPROFILE%,
    // %LOCALAPPDATA%, etc.
    const value = process.env[name];
    return typeof value === 'string' ? value : match;
  });
}

/**
 * Query a single Windows registry PATH value.  Returns '' on any
 * error (missing key, missing value, reg.exe not present) so the
 * caller can gracefully fall back to its previous value.
 *
 * @param {string} keyPath - e.g. "HKCU\\Environment"
 * @returns {string}
 */
function readRegistryPath(keyPath) {
  try {
    const raw = execFileSync('reg', ['query', keyPath, '/v', 'Path'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    // reg.exe output looks like:
    //
    //   HKEY_CURRENT_USER\Environment
    //       Path    REG_EXPAND_SZ    C:\Users\foo\scoop\shims;C:\Users\foo\...
    //
    // Find the line starting with optional whitespace + "Path", skip
    // the type token, then join the rest back with spaces in case the
    // value itself contains spaces.  Expand any `%VAR%` references in
    // the result — REG_EXPAND_SZ values typically contain unexpanded
    // `%USERPROFILE%` / `%LOCALAPPDATA%` placeholders that Windows
    // would normally substitute when creating a new process, but
    // reg.exe prints them raw.
    const match = raw.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/mi);
    if (match && match[1]) {
      return expandWindowsEnvVars(match[1].trim());
    }
  } catch (_) {
    // Key missing, value missing, or reg.exe not available.
  }
  return '';
}

/**
 * Windows-only: re-read User PATH + Machine PATH from the registry
 * and rebuild `process.env.PATH` from scratch.  Prepends the cached
 * extraPathPrefixes so the boot-time augmentation isn't lost.  On
 * non-Windows platforms this is a no-op.
 *
 * @returns {boolean} true if PATH actually changed, false otherwise.
 */
function refreshSystemPathFromRegistry() {
  if (process.platform !== 'win32') return false;

  const machinePath = readRegistryPath(
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  );
  const userPath = readRegistryPath('HKCU\\Environment');
  if (!machinePath && !userPath) {
    // reg.exe failed for both — leave PATH alone, don't pretend we
    // refreshed anything.
    return false;
  }

  // Windows composes the effective PATH as Machine first, then User
  // appended (HKLM then HKCU).  Honour that order so the result
  // matches what a brand-new cmd.exe would see.
  const composed = [machinePath, userPath].filter(Boolean).join(path.delimiter);

  // Prepend the extras we added at boot so our augmentation stays
  // sticky across refreshes.
  const pieces = [..._cachedExtraPrefixes, ...composed.split(path.delimiter)];
  const deduped = [...new Set(pieces.filter(Boolean))].join(path.delimiter);

  if (deduped === process.env.PATH) return false;
  process.env.PATH = deduped;
  return true;
}

module.exports = {
  applyExtraPathPrefixes,
  refreshSystemPathFromRegistry,
};
