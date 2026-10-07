'use strict';

/**
 * First-run bootstrap for the bundled Python environment.
 *
 * On a fresh install the packaged app ships the whisperflow Python sources
 * and a requirements.txt but NOT the (~2 GB) installed venv — we don't want
 * to bloat the installer.  The first time the user triggers a transcription,
 * this module:
 *
 *   1. Creates the venv at the location chosen by `getVenvRoot()`
 *      (project-local in dev, userData in packaged builds).
 *   2. Runs `python -m pip install -r requirements.txt` inside the venv.
 *   3. Streams progress lines back via an `onLog` callback so the UI can
 *      display "Installing torch…" instead of sitting silently for minutes.
 *
 * The helper is synchronous-looking but uses Promises — the caller is
 * expected to `await` it before spawning anything that imports whisperflow.
 *
 * Two marker files live in the venv root:
 *
 *   .whisperflow-installed     an ISO timestamp; "this venv was built"
 *   .whisperflow-requirements  sha256 of requirements.txt; "with these deps"
 *
 * The second one is what makes dependency upgrades detectable.  Before it
 * existed, `isVenvInitialized()` returned true forever and an existing
 * user never picked up a new entry in requirements.txt.  Keeping it as a
 * *separate* file means a pre-1.17 venv (marker present, hash absent)
 * reads as "stale", not as "uninitialized" — so `isVenvInitialized()`
 * keeps its original meaning and the two gates that depend on it
 * (preflight-checker.js, ipc-handlers.js's run gate) are unaffected.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getVenvPythonPath } = require('./path-resolver');
const { t } = require('./i18n');

const INSTALLED_MARKER = '.whisperflow-installed';
const REQUIREMENTS_MARKER = '.whisperflow-requirements';

function isVenvInitialized(venvRoot) {
  const pythonPath = getVenvPythonPath(venvRoot);
  const marker = path.join(venvRoot, INSTALLED_MARKER);
  return fs.existsSync(pythonPath) && fs.existsSync(marker);
}

/**
 * sha256 of requirements.txt's raw bytes, or null if it can't be read.
 *
 * Raw bytes rather than a normalised line set: any edit, comments
 * included, then triggers one incremental `pip install -r`, which for an
 * already-satisfied set takes a few seconds.  Normalising would be more
 * code for a worse failure mode (a missed upgrade).
 */
function requirementsHash(requirementsPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(requirementsPath)).digest('hex');
  } catch (_) {
    return null;
  }
}

function readInstalledRequirementsHash(venvRoot) {
  try {
    const raw = fs.readFileSync(path.join(venvRoot, REQUIREMENTS_MARKER), 'utf-8');
    return raw.trim() || null;
  } catch (_) {
    return null;
  }
}

function writeInstalledRequirementsHash(venvRoot, hash) {
  if (!hash) return;
  try {
    fs.writeFileSync(path.join(venvRoot, REQUIREMENTS_MARKER), hash, 'utf-8');
  } catch (_) {
    // Non-fatal: the worst case is we offer the update again next launch.
  }
}

/**
 * Whether the venv exists and whether its dependencies are current.
 *
 * `upToDate` is false for a pre-1.17 venv, whose hash file is simply
 * missing — which is exactly the upgrade signal we want, with no
 * migration step.  It is also false (vacuously) when the venv does not
 * exist at all; callers should check `initialized` first.
 */
function getVenvState({ venvRoot, requirementsPath }) {
  const expectedHash = requirementsHash(requirementsPath);
  const installedHash = readInstalledRequirementsHash(venvRoot);
  return {
    initialized: isVenvInitialized(venvRoot),
    upToDate: Boolean(expectedHash) && installedHash === expectedHash,
    expectedHash,
    installedHash,
  };
}

function runSpawn(cmd, args, { cwd, onLog }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const onChunk = (buf) => {
      if (typeof onLog === 'function') onLog(buf.toString('utf-8'));
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(cmd)} exited with code ${code}`));
      }
    });
  });
}

async function createVenv({ systemPython, venvRoot, onLog }) {
  if (fs.existsSync(venvRoot)) return;

  // Make sure the parent directory exists; in packaged builds the userData
  // dir is created by Electron, but a deeply-nested venvRoot may still need
  // its parent folders.
  fs.mkdirSync(path.dirname(venvRoot), { recursive: true });

  if (typeof onLog === 'function') {
    onLog(`[WhisperFlow] ${t('events:log.venvCreating', { path: venvRoot })}\n`);
  }
  await runSpawn(systemPython, ['-m', 'venv', venvRoot], { cwd: path.dirname(venvRoot), onLog });
}

async function installRequirements({ venvRoot, requirementsPath, onLog }) {
  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`requirements file not found: ${requirementsPath}`);
  }

  // Upgrade pip via `python -m pip install --upgrade pip`, NOT via the
  // pip.exe shim directly.  On Windows, running pip.exe to upgrade
  // itself fails because the .exe file is locked while it's executing
  // — pip detects this and refuses with:
  //   "ERROR: To modify pip, please run the following command:
  //    <python> -m pip install --upgrade pip"
  // The `python -m pip` invocation works on every platform and avoids
  // the self-lock issue entirely.  Same reasoning applies to the
  // requirements install step for consistency.
  const venvPython = getVenvPythonPath(venvRoot);

  if (typeof onLog === 'function') {
    onLog(`[WhisperFlow] ${t('events:log.venvUpgradingPip')}\n`);
  }
  await runSpawn(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: venvRoot, onLog });

  if (typeof onLog === 'function') {
    onLog(`[WhisperFlow] ${t('events:log.venvInstallingDeps', { path: requirementsPath })}\n`);
  }
  await runSpawn(venvPython, ['-m', 'pip', 'install', '-r', requirementsPath], { cwd: venvRoot, onLog });
}

async function initializeBundledVenv({
  systemPython,
  venvRoot,
  requirementsPath,
  onLog,
}) {
  await createVenv({ systemPython, venvRoot, onLog });
  await installRequirements({ venvRoot, requirementsPath, onLog });

  // Drop a marker file so we can detect "installed and ready" without
  // re-running pip on every app launch.
  const marker = path.join(venvRoot, INSTALLED_MARKER);
  fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');

  // ...and record which requirements.txt it was built from, so a fresh
  // install is born up to date.
  writeInstalledRequirementsHash(venvRoot, requirementsHash(requirementsPath));
}

/**
 * Bring an existing venv's dependencies up to date.
 *
 * Deliberately does NOT call `createVenv()`: that returns early when
 * `venvRoot` already exists, so calling it here would be a no-op at best
 * and misleading at worst.  `installRequirements()` is reused as-is — pip
 * is already incremental, so an existing venv only fetches what is new
 * and applies any changed constraint.
 */
async function updateVenvRequirements({ venvRoot, requirementsPath, onLog }) {
  await installRequirements({ venvRoot, requirementsPath, onLog });
  writeInstalledRequirementsHash(venvRoot, requirementsHash(requirementsPath));
}

module.exports = {
  INSTALLED_MARKER,
  REQUIREMENTS_MARKER,
  getVenvState,
  initializeBundledVenv,
  isVenvInitialized,
  readInstalledRequirementsHash,
  requirementsHash,
  updateVenvRequirements,
};
