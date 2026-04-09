'use strict';

const { spawn } = require('child_process');
const stripAnsi = require('strip-ansi');

let activeProcess = null;
let activeState = 'idle';
let exitCodeOverride = null;

function isUnixLike() {
  return process.platform !== 'win32';
}

function signalActiveProcess(signal) {
  if (!activeProcess?.pid) return false;

  try {
    if (isUnixLike()) {
      process.kill(-activeProcess.pid, signal);
    } else {
      activeProcess.kill(signal);
    }
    return true;
  } catch (_) {
    try {
      activeProcess.kill(signal);
      return true;
    } catch (_) {
      return false;
    }
  }
}

function settleProcess(child, onClose, code) {
  if (activeProcess === child) {
    activeProcess = null;
    activeState = 'idle';
    exitCodeOverride = null;
  }
  onClose(code);
}

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
  if (activeProcess) {
    stopProcess(-2);
  }

  exitCodeOverride = null;
  activeState = 'running';

  const child = spawn(
    poetryPath,
    ['run', 'python', scriptPath, ...args],
    {
      cwd,
      detached: isUnixLike(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        WHISPERFLOW_POETRY_PATH: poetryPath,
      },
    }
  );

  activeProcess = child;

  let settled = false;
  function finalize(code) {
    if (settled) return;
    settled = true;
    settleProcess(child, onClose, code);
  }

  child.stdout.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString('utf-8'));
    if (text) onData(text);
  });

  child.stderr.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString('utf-8'));
    if (text) onError(text);
  });

  child.on('close', (code) => {
    const finalCode = exitCodeOverride ?? (typeof code === 'number' ? code : -1);
    finalize(finalCode);
  });

  child.on('error', (err) => {
    onError(`[Process error] ${err.message}\n`);
    finalize(-1);
  });

  return child;
}

function pauseProcess() {
  if (!activeProcess || activeState !== 'running' || !isUnixLike()) return false;

  const paused = signalActiveProcess('SIGSTOP');
  if (paused) {
    activeState = 'paused';
  }
  return paused;
}

function resumeProcess() {
  if (!activeProcess || activeState !== 'paused' || !isUnixLike()) return false;

  const resumed = signalActiveProcess('SIGCONT');
  if (resumed) {
    activeState = 'running';
  }
  return resumed;
}

/**
 * Stop the currently running process, if any.
 */
function stopProcess(codeOverride = -2) {
  if (!activeProcess) return false;

  exitCodeOverride = codeOverride;

  if (activeState === 'paused' && isUnixLike()) {
    signalActiveProcess('SIGCONT');
  }

  activeState = 'stopping';
  return signalActiveProcess('SIGTERM');
}

function isRunning() {
  return activeProcess !== null;
}

function isPaused() {
  return activeState === 'paused';
}

module.exports = {
  isPaused,
  isRunning,
  pauseProcess,
  resumeProcess,
  runScript,
  stopProcess,
};
