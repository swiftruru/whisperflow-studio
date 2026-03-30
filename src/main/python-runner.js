'use strict';

const { spawn } = require('child_process');
const stripAnsi = require('strip-ansi');

let activeProcess = null;

/**
 * Spawn a Python script and stream stdout/stderr back via callbacks.
 *
 * @param {string} poetryPath   - absolute path to the poetry executable
 * @param {string} scriptPath   - absolute path to the Python script
 * @param {string[]} args       - additional CLI arguments for the script
 * @param {string} cwd          - working directory (Python project root)
 * @param {Function} onData     - called with each stdout text chunk (string)
 * @param {Function} onError    - called with each stderr text chunk (string)
 * @param {Function} onClose    - called with exit code (number) when process ends
 * @returns {ChildProcess}
 */
function runScript(poetryPath, scriptPath, args, cwd, onData, onError, onClose) {
  // Kill any previous process
  stopProcess();

  const child = spawn(
    poetryPath,
    ['run', 'python', scriptPath, ...args],
    {
      cwd,
      env: {
        ...process.env,  // includes the augmented PATH set in main.js
        PYTHONUNBUFFERED: '1',      // force Python to flush stdout immediately
        PYTHONIOENCODING: 'utf-8',  // handle CJK filenames
        WHISPERFLOW_POETRY_PATH: poetryPath, // pass resolved path for sub-processes
      },
    }
  );

  activeProcess = child;

  child.stdout.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString('utf-8'));
    if (text) onData(text);
  });

  child.stderr.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString('utf-8'));
    if (text) onError(text);
  });

  child.on('close', (code) => {
    if (activeProcess === child) activeProcess = null;
    onClose(code);
  });

  child.on('error', (err) => {
    onError(`[Process error] ${err.message}\n`);
    if (activeProcess === child) activeProcess = null;
    onClose(-1);
  });

  return child;
}

/**
 * Kill the currently running process, if any.
 */
function stopProcess() {
  if (activeProcess) {
    try {
      activeProcess.kill('SIGTERM');
    } catch (_) {}
    activeProcess = null;
  }
}

function isRunning() {
  return activeProcess !== null;
}

module.exports = { runScript, stopProcess, isRunning };
