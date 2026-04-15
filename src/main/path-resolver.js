'use strict';

const { execFileSync, execSync } = require('child_process');
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
 *   3. Self-report (ask Python itself for ``sys.executable`` via every
 *      shim we can find on PATH — handles pyenv-win .bat shims, conda,
 *      scoop, py-launcher, etc.)
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

  const viaSelfReport = resolveViaPythonSelfReport();
  if (viaSelfReport) {
    return viaSelfReport;
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
 * Find the *real* python.exe path by asking Python itself.
 *
 * For each Python-ish executable on PATH, run
 * ``<candidate> -c "import sys; print(sys.executable)"`` through the
 * shell and use whatever path Python prints back.  This is the only
 * approach that works uniformly across every Windows Python install:
 *
 *   - python.org installer   → finds the regular .exe
 *   - **pyenv-win**          → the shim is a ``python.bat`` that
 *     forwards to ``versions/<x.y.z>/python.exe``; running it through
 *     ``cmd.exe`` resolves the .bat correctly and Python prints the
 *     real underlying path
 *   - Microsoft Store        → the stub fails (or prints non-Python
 *     output), we silently skip it
 *   - conda / scoop / chocolatey / venv / virtualenv → all work,
 *     because Python always knows its own location
 *
 * The shell route is essential because Node's ``spawn`` on Windows
 * goes through ``CreateProcess``, which can't directly execute .bat
 * files — but ``execSync`` defaults to ``cmd.exe`` on Windows, which
 * can.
 *
 * Returns the absolute path to a real python.exe, or ``null``.
 */
function resolveViaPythonSelfReport() {
  for (const candidate of listPythonShimCandidates()) {
    const real = askPythonForSelfPath(candidate);
    if (real) {
      return real;
    }
  }
  return null;
}

/**
 * Enumerate every Python-launcher-shaped file on PATH that we could
 * plausibly hand to ``askPythonForSelfPath``.  Uses the OS's native
 * lookup so we get the same set the user's shell sees.
 */
function listPythonShimCandidates() {
  const isWindows = process.platform === 'win32';
  const lookupCmd = isWindows ? 'where.exe' : 'which';

  // On Windows ``where.exe python`` (no extension) follows %PATHEXT% so
  // it returns python.exe, python.bat, python.cmd, and even the bare
  // ``python`` Bash shim if pyenv-win installed one.  We DON'T want to
  // restrict to ``python.exe`` here — that's what made v1.4.1 miss
  // pyenv-win shims entirely.
  const shimNames = isWindows
    ? ['python', 'python3', 'py']
    : ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python'];

  const seen = new Set();
  const results = [];

  for (const name of shimNames) {
    let stdout = '';
    try {
      stdout = execFileSync(lookupCmd, [name], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (_) {
      // where.exe / which exits non-zero when nothing matches — that's
      // expected, just move on.
      continue;
    }

    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      if (!fs.existsSync(trimmed)) continue;
      seen.add(trimmed);
      results.push(trimmed);
    }
  }

  return results;
}

/**
 * Run ``<candidate> -c "import sys; print(sys.executable)"`` and return
 * the printed path if it looks like a real Python interpreter.
 *
 * Goes through ``execSync`` (which on Windows defaults to cmd.exe) so
 * .bat / .cmd shims like pyenv-win's resolve correctly.  Microsoft
 * Store stubs typically exit with a non-zero code or print marketing
 * output instead of a real path; either way we'll catch it and return
 * null so the caller moves on to the next candidate.
 */
function askPythonForSelfPath(candidate) {
  const isWindows = process.platform === 'win32';
  // cmd.exe quoting: the entire command line gets wrapped in another
  // pair of double quotes by cmd's parser, so embedded paths with
  // spaces need to be quoted, and the python ``-c`` body — which
  // contains a semicolon — needs its own pair of quotes too.
  const commandLine = isWindows
    ? `""${candidate}" -c "import sys; print(sys.executable)""`
    : `"${candidate}" -c 'import sys; print(sys.executable)'`;

  let stdout = '';
  try {
    stdout = execSync(commandLine, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
  } catch (_) {
    return null;
  }

  // The shim printed something — make sure it's a path that exists and
  // doesn't look like a Microsoft Store error message ("Python was not
  // found; run without arguments to install from the Microsoft Store...").
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/microsoft store|was not found|install from/i.test(trimmed)) continue;
    if (!fs.existsSync(trimmed)) continue;
    return trimmed;
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
