'use strict';

const { spawn } = require('child_process');
const stripAnsi = require('strip-ansi');
const { parseRunnerEventLine } = require('./runner-event');
const { t } = require('./i18n');

// Known English log patterns emitted by the Python backend that we want
// to rewrite with the user's current UI language before sending them to
// the Console.  Python itself doesn't know the UI locale, so we do this
// here in the main process just before forwarding stdout to the renderer.
//
// Note: the per-segment "[start -> end] text" lines that Whisper prints
// while decoding are deliberately NOT on this list — those timestamps
// and transcript text are user content, not app messages, so we leave
// them untouched.  Only high-signal status / lifecycle messages are
// translated here.
const LOG_REWRITE_PATTERNS = [
  {
    regex: /^✔ Transcription completed in ([\d.]+)s$/,
    translate: (match) => t('events:log.transcriptionCompleted', { seconds: match[1] }),
  },
  {
    regex: /^CUDA runtime unavailable, falling back to device=cpu, compute_type=(.+?) \(was compute_type=(.+?)\)$/,
    translate: (match) => t('events:log.cudaFallbackToCpu', {
      newComputeType: match[1],
      oldComputeType: match[2],
    }),
  },
  {
    regex: /^loading faster-whisper model (.+?) \(device=(.+?), compute_type=(.+?)\)$/,
    translate: (match) => t('events:log.loadingWhisperModel', {
      model: match[1],
      device: match[2],
      compute_type: match[3],
    }),
  },
  {
    regex: /^silero-vad imported from system torch hub cache$/,
    translate: () => t('events:log.sileroImportedFromCache'),
  },
  {
    regex: /^silero VAD model loaded$/,
    translate: () => t('events:log.sileroModelLoaded'),
  },
  {
    regex: /^silero VAD model loaded from cache$/,
    translate: () => t('events:log.sileroModelLoadedFromCache'),
  },
  {
    regex: /^silero VAD scanning (.+) \(([\d.]+)s -> ([\d.]+)s\)$/,
    translate: (match) => t('events:log.sileroScanning', {
      path: match[1],
      start: match[2],
      end: match[3],
    }),
  },
  {
    regex: /^non-speech strategy (.+) produced (\d+) segments$/,
    translate: (match) => t('events:log.nonSpeechStrategy', {
      strategy: match[1],
      count: match[2],
    }),
  },
  {
    regex: /^wrote SRT: (.+)$/,
    translate: (match) => t('events:log.wroteSrt', { path: match[1] }),
  },
  {
    regex: /^whisper \+ VAD took ([\d.]+)s$/,
    translate: (match) => t('events:log.whisperVadTook', { seconds: match[1] }),
  },
  {
    regex: /^parallel transcription took ([\d.]+)s$/,
    translate: (match) => t('events:log.parallelTranscriptionTook', { seconds: match[1] }),
  },
  {
    regex: /^worker using CUDA device (.+)$/,
    translate: (match) => t('events:log.workerCuda', { device: match[1] }),
  },
  {
    regex: /^imported (.+) from system HuggingFace cache$/,
    translate: (match) => t('events:log.importedFromHfCache', { model: match[1] }),
  },
  {
    regex: /^downloading model (.+) into (.+)$/,
    translate: (match) => t('events:log.downloadingModel', {
      model: match[1],
      dir: match[2],
    }),
  },
];

// Lines rewritten above are app-origin status messages, not user content
// (Whisper's per-segment "[HH:MM:SS] text" lines).  Prefix them with
// `[Python]` so the Console filter + classifyLine can distinguish Python
// backend logs from main-process `[WhisperFlow]` logs and from transcript
// text in one glance, and so the user can filter them by level using
// the same keyword rules the main-process logs already use.
function rewriteBackendLogLine(line) {
  for (const rule of LOG_REWRITE_PATTERNS) {
    const match = rule.regex.exec(line);
    if (match) return `[Python] ${rule.translate(match)}`;
  }
  return line;
}

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

    onData(`${rewriteBackendLogLine(line)}\n`);
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
