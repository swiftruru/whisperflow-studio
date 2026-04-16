'use strict';

const { spawn } = require('child_process');
const stripAnsi = require('strip-ansi');
const { parseRunnerEventLine } = require('./runner-event');

let activeProcess = null;
let activeState = 'idle';
let exitCodeOverride = null;

function isIgnorableShutdownWarning(text) {
  return /resource_tracker: There appear to be \d+ leaked semaphore objects to clean up at shutdown/i.test(String(text || ''));
}

function shouldSuppressStderr(text) {
  return activeState === 'stopping' && isIgnorableShutdownWarning(text);
}

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

function createLineBuffer(onLine) {
  let buffer = '';

  return {
    push(text) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach((line) => onLine(line));
    },
    flush() {
      if (!buffer) return;
      onLine(buffer);
      buffer = '';
    },
  };
}

/**
 * Spawn a Python script and stream stdout/stderr back via callbacks.
 *
 * @param {string} pythonPath   - absolute path to the Python interpreter (bundled venv)
 * @param {string} scriptPath   - absolute path to the Python script
 * @param {string[]} args       - additional CLI arguments for the script
 * @param {string} cwd          - working directory
 * @param {Function} onData     - called with each stdout text chunk (string)
 * @param {Function} onError    - called with each stderr text chunk (string)
 * @param {Function} onClose    - called with exit code (number) when process ends
 * @param {Function|null} onEvent - called with structured runner event objects
 * @returns {ChildProcess}
 */
function runScript(pythonPath, scriptPath, args, cwd, onData, onError, onClose, onEvent = null) {
  if (activeProcess) {
    stopProcess(-2);
  }

  exitCodeOverride = null;
  activeState = 'running';

  const child = spawn(
    pythonPath,
    [scriptPath, ...args],
    {
      cwd,
      detached: isUnixLike(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    }
  );

  activeProcess = child;

  const stdoutBuffer = createLineBuffer((line) => {
    const parsedEvent = parseRunnerEventLine(line);
    if (parsedEvent) {
      if (typeof onEvent === 'function') onEvent(parsedEvent);
      return;
    }

    onData(`${line}\n`);
  });

  let settled = false;
  function finalize(code) {
    if (settled) return;
    settled = true;
    stdoutBuffer.flush();
    settleProcess(child, onClose, code);
  }

  child.stdout.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString('utf-8'));
    if (text) stdoutBuffer.push(text);
  });

  child.stderr.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString('utf-8'));
    if (!text || shouldSuppressStderr(text)) return;
    onError(text);
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
  createLineBuffer,
  isPaused,
  isRunning,
  pauseProcess,
  resumeProcess,
  runScript,
  stopProcess,
};
