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
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { getVenvPythonPath } = require('./path-resolver');

function isVenvInitialized(venvRoot) {
  const pythonPath = getVenvPythonPath(venvRoot);
  const marker = path.join(venvRoot, '.whisperflow-installed');
  return fs.existsSync(pythonPath) && fs.existsSync(marker);
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
    onLog(`[WhisperFlow] Creating virtualenv at ${venvRoot}\n`);
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
    onLog('[WhisperFlow] Upgrading pip…\n');
  }
  await runSpawn(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: venvRoot, onLog });

  if (typeof onLog === 'function') {
    onLog(`[WhisperFlow] Installing dependencies from ${requirementsPath}…\n`);
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
  const marker = path.join(venvRoot, '.whisperflow-installed');
  fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');
}

module.exports = {
  initializeBundledVenv,
  isVenvInitialized,
};
