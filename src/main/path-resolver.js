'use strict';

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
 * Precedence: user override > known platform paths > $PATH fallback.
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

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const candidates = process.platform === 'win32'
    ? ['python.exe', 'python3.exe']
    : ['python3', 'python3.12', 'python3.11', 'python3.10'];

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

module.exports = {
  getBundledPythonSettings,
  getVenvPipPath,
  getVenvPythonPath,
  getVenvRoot,
  resolveBundledPython,
  resolveSystemPython,
};
