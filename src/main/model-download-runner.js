'use strict';

/**
 * Dedicated child-process manager for model downloads.
 *
 * Separate from the transcription runner (python-runner.js) so downloads
 * can happen concurrently with transcription without clobbering each
 * other's `activeProcess` slot.  v1 limits to one download at a time
 * (the Map-based expansion for concurrent downloads is noted in the plan
 * but left for a future version).
 *
 * Flow:
 *   1. `startDownload(opts)` spawns `python -m whisperflow.cli
 *      --download-model <name> --emit-events --models-dir <dir>`
 *   2. stdout is piped through `createLineBuffer` → `parseRunnerEventLine`
 *      → `handleEvent()`, which mutates `download-state.js`
 *   3. `cancelDownload(id)` kills the child via taskkill (Windows) or
 *      SIGTERM→SIGKILL (POSIX)
 *   4. On process close, the download entry is finalized in state
 */

const { spawn, execFileSync } = require('child_process');
const { createLineBuffer } = require('./python-runner');
const { parseRunnerEventLine } = require('./runner-event');
const downloadState = require('./download-state');

let _active = null; // { id, child, name, cancelled, stderrTail }

// Known Windows NTSTATUS codes we occasionally see when Python is killed
// mid-download (antivirus, OOM killer, etc.).  Decoding them turns the
// 10-digit exit code into something a human can act on.
const _NTSTATUS_NAMES = {
  0xC0000005: 'ACCESS_VIOLATION',
  0xC000001D: 'ILLEGAL_INSTRUCTION',
  0xC0000017: 'NO_MEMORY',
  0xC00000FD: 'STACK_OVERFLOW',
  0xC000013A: 'CONTROL_C_EXIT',
  0xC0000142: 'DLL_INIT_FAILED',
  0xC0000409: 'STACK_BUFFER_OVERRUN',
  0xC0000374: 'HEAP_CORRUPTION',
  0xC0000139: 'ENTRYPOINT_NOT_FOUND',
};

function _describeExitCode(code) {
  if (code === null || code === undefined) return 'signal';
  if (code >= 0 && code < 256) return String(code);
  const unsigned = code < 0 ? code + 0x100000000 : code;
  const name = _NTSTATUS_NAMES[unsigned];
  const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`;
  return name ? `${hex} (${name})` : hex;
}

// Keep a rolling tail of stderr so that when Python dies without emitting
// a download-error event we can surface the actual traceback instead of
// just "Python exited with code N".
const _STDERR_TAIL_MAX = 4096;

function _appendTail(prev, chunk, max) {
  const combined = prev + chunk;
  return combined.length > max ? combined.slice(combined.length - max) : combined;
}

function _cleanStderrTail(tail) {
  if (!tail) return '';
  // Drop tqdm progress-bar lines (they contain carriage returns and end
  // with bytes/ETA noise) and empty lines.
  const lines = tail
    .split(/\r?\n/)
    .map((ln) => ln.split('\r').pop().trim())
    .filter((ln) => ln && !/^\d+%\|[█▏▎▍▌▋▊▉ ]/.test(ln));
  // Prefer the last few meaningful lines.
  return lines.slice(-8).join(' | ').slice(-500);
}

function startDownload({ id, name, venvPython, pythonDir, modelsDir }) {
  if (_active) {
    throw new Error('Another download is already running');
  }

  const args = ['-m', 'whisperflow.cli', '--download-model', name, '--emit-events'];
  if (modelsDir) {
    args.push('--models-dir', modelsDir);
  }

  const child = spawn(venvPython, args, {
    cwd: pythonDir,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  });

  _active = { id, child, name, cancelled: false, stderrTail: '' };

  const lineBuffer = createLineBuffer((line) => {
    const evt = parseRunnerEventLine(line);
    if (!evt) return;
    _handleEvent(id, evt);
  });

  child.stdout.on('data', (buf) => {
    lineBuffer.push(buf.toString('utf-8'));
  });

  child.stderr.on('data', (buf) => {
    const text = buf.toString('utf-8');
    if (_active) {
      _active.stderrTail = _appendTail(_active.stderrTail, text, _STDERR_TAIL_MAX);
    }
    if (text.trim()) {
      console.error(`[download:${name}] ${text.trimEnd()}`);
    }
  });

  child.on('close', (code, signal) => {
    lineBuffer.flush();
    const wasCancelled = _active?.cancelled;
    const stderrTail = _cleanStderrTail(_active?.stderrTail || '');
    _active = null;

    if (wasCancelled) {
      downloadState.updateDownload(id, {
        status: 'cancelled',
        errorCode: 'CANCELLED_BY_USER',
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    // The `download-completed` event from Python should have already
    // flipped status.  If it hasn't (e.g. Python crashed mid-stream),
    // use the exit code as a backstop.
    const current = downloadState.getDownload(id);
    if (current && current.status === 'running') {
      if (code === 0) {
        downloadState.updateDownload(id, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
        });
      } else {
        const exitDesc = signal ? `signal=${signal}` : `exit=${_describeExitCode(code)}`;
        const message = stderrTail
          ? `${stderrTail} [${exitDesc}]`
          : `Python exited unexpectedly (${exitDesc})`;
        downloadState.updateDownload(id, {
          status: 'failed',
          errorCode: 'PROCESS_EXIT',
          errorMessage: message,
          finishedAt: new Date().toISOString(),
        });
      }
    }
  });

  child.on('error', (err) => {
    _active = null;
    downloadState.updateDownload(id, {
      status: 'failed',
      errorCode: 'SPAWN_FAILED',
      errorMessage: err.message,
      finishedAt: new Date().toISOString(),
    });
  });
}

function cancelDownload(id) {
  if (!_active || _active.id !== id) return false;
  _active.cancelled = true;
  const child = _active.child;
  const pid = child.pid;

  try {
    if (process.platform === 'win32' && typeof pid === 'number') {
      // /T kills the whole process tree — otherwise pip/curl children
      // spawned by huggingface_hub keep running as orphans.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (_active?.child === child && !child.killed) {
            child.kill('SIGKILL');
          }
        } catch (_) { /* ignore */ }
      }, 2000);
    }
  } catch (_) {
    try { child.kill(); } catch (_2) { /* ignore */ }
  }

  return true;
}

function isDownloading() {
  return _active !== null;
}

function getActiveDownloadId() {
  return _active?.id || null;
}

function _handleEvent(id, evt) {
  const type = evt.type || '';
  const meta = evt.meta || {};

  if (type === 'download-stage') {
    downloadState.updateDownload(id, { stage: meta.stage || evt.stage || '' });
  } else if (type === 'download-progress') {
    downloadState.updateDownload(id, {
      downloadedBytes: meta.downloaded_bytes ?? 0,
      totalBytes: meta.total_bytes ?? 0,
      speedBytesPerSec: meta.speed_bytes_per_sec ?? 0,
      etaSeconds: meta.eta_seconds ?? 0,
    });
  } else if (type === 'download-completed') {
    downloadState.updateDownload(id, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
    });
  } else if (type === 'download-error') {
    downloadState.updateDownload(id, {
      status: 'failed',
      errorCode: meta.error_class || 'DOWNLOAD_ERROR',
      errorMessage: evt.message || 'Unknown download error',
      finishedAt: new Date().toISOString(),
    });
  }
}

module.exports = {
  startDownload,
  cancelDownload,
  isDownloading,
  getActiveDownloadId,
};
