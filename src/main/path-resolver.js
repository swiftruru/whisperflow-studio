'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readConfigMetadata } = require('./config-metadata');

function expandHomePath(value) {
  return typeof value === 'string' ? value.replace(/\$\{HOME\}/g, os.homedir()) : value;
}

function getKnownPythonPaths(configMetadataPath, platform = process.platform) {
  const metadata = readConfigMetadata(configMetadataPath);
  const list = metadata?.appRuntime?.knownPythonPaths?.[platform] || [];
  return list.map(expandHomePath).filter((p) => typeof p === 'string' && p.length > 0);
}

function getBundledPythonSettings(configMetadataPath) {
  const metadata = readConfigMetadata(configMetadataPath);
  const bundled = metadata?.appRuntime?.bundledPython || {};
  return {
    venvDirName: bundled.venvDirName || '.venv',
    requirementsFile: bundled.requirementsFile || 'requirements.txt',
    minPythonVersion: bundled.minPythonVersion || '3.10',
  };
}

/**
 * Decide where the bundled Python venv lives on disk.
 *
 * Dev mode: alongside the source tree at `<project>/python/.venv` so the
 * developer can poke at it from their IDE.
 *
 * Packaged build: under Electron's `userData` directory.  This is the only
 * place in a packaged app that's reliably writable across all three
 * platforms — `process.resourcesPath` lives inside `/Applications/...`,
 * `Program Files\...`, or a read-only AppImage mount, none of which the
 * user can write to without admin.
 *
 * @param {Object} options
 * @param {string} options.electronAppRoot  - dev: project root; packaged: process.resourcesPath
 * @param {boolean} options.isPackaged      - app.isPackaged
 * @param {string} options.userDataDir      - app.getPath('userData')
 * @param {string} options.configMetadataPath - path to config.metadata.json
 * @returns {string} absolute path to the venv directory
 */
function getVenvRoot({ electronAppRoot, isPackaged, userDataDir, configMetadataPath }) {
  const { venvDirName } = getBundledPythonSettings(configMetadataPath);
  if (isPackaged) {
    return path.join(userDataDir, venvDirName);
  }
  return path.join(electronAppRoot, 'python', venvDirName);
}

function getVenvPythonPath(venvRoot) {
  if (process.platform === 'win32') {
    return path.join(venvRoot, 'Scripts', 'python.exe');
  }
  return path.join(venvRoot, 'bin', 'python');
}

function getVenvPipPath(venvRoot) {
  if (process.platform === 'win32') {
    return path.join(venvRoot, 'Scripts', 'pip.exe');
  }
  return path.join(venvRoot, 'bin', 'pip');
}

/**
 * Locate the Python interpreter inside the bundled venv.
 *
 * Returns the absolute path if the venv has been created, else `null` so
 * callers can decide to trigger venv initialisation.
 */
function resolveBundledPython(venvRoot) {
  const venvPython = getVenvPythonPath(venvRoot);
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return null;
}

/**
 * Find a system Python 3 interpreter capable of creating the venv on first run.
 *
 * Precedence:
 *   1. User override (explicit `pythonPath` setting)
 *   2. Known platform paths (config.metadata.json :: knownPythonPaths)
 *   3. Shell-which (delegates to `where.exe` on Windows / `which` on POSIX)
 *      so we find exactly the same interpreter the user's terminal uses
 *   4. Manual $PATH iteration as a last resort
 *
 * Returns `null` if nothing suitable is found.
 */
function resolveSystemPython(userOverride, configMetadataPath) {
  const trimmedOverride = typeof userOverride === 'string' ? userOverride.trim() : '';
  if (trimmedOverride && fs.existsSync(trimmedOverride)) {
    return trimmedOverride;
  }

  for (const candidate of getKnownPythonPaths(configMetadataPath)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const viaShell = resolveViaShellWhich();
  if (viaShell) {
    return viaShell;
  }

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const candidates = process.platform === 'win32'
    ? ['python.exe', 'python3.exe', 'py.exe']
    : ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10'];

  for (const dir of pathDirs) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Ask the OS where Python lives, the same way the user's shell would.
 *
 * On Windows: calls ``where.exe python``.  This matches whatever
 * ``python --version`` resolves to in PowerShell / cmd, which is the
 * single source of truth for "which Python is on PATH" on this machine.
 * Avoids the brittleness of trying to enumerate every possible install
 * location ourselves (Python 3.13 from python.org, MS Store stub,
 * Chocolatey, scoop, conda, py-launcher, ...).
 *
 * On POSIX: calls ``which python3`` for symmetry, though our fallback
 * usually finds it via the known-paths list first.
 *
 * Returns the absolute path to the first valid candidate, or null if
 * the OS can't find anything.
 */
function resolveViaShellWhich() {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where.exe' : 'which';
  const candidates = isWindows
    ? ['python.exe', 'python3.exe', 'py.exe']
    : ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10'];

  for (const name of candidates) {
    let stdout = '';
    try {
      stdout = execFileSync(cmd, [name], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // ``where.exe`` exits non-zero when nothing is found, which would
        // otherwise throw — execFileSync's catch handles that.
        windowsHide: true,
      });
    } catch (_) {
      continue;
    }

    // ``where`` may return multiple lines (e.g. matches in several PATH
    // dirs); take the first existing one.
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && fs.existsSync(trimmed)) {
        return trimmed;
      }
    }
  }

  return null;
}

module.exports = {
  getBundledPythonSettings,
  getVenvPipPath,
  getVenvPythonPath,
  getVenvRoot,
  resolveBundledPython,
  resolveSystemPython,
};
