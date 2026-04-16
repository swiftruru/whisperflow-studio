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

let _active = null; // { id, child, name, cancelled }

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

  _active = { id, child, name, cancelled: false };

  const lineBuffer = createLineBuffer((line) => {
    const evt = parseRunnerEventLine(line);
    if (!evt) return;
    _handleEvent(id, evt);
  });

  child.stdout.on('data', (buf) => {
    lineBuffer.push(buf.toString('utf-8'));
  });

  child.stderr.on('data', (buf) => {
    // stderr goes to main-process console for debugging; not into state.
    const text = buf.toString('utf-8');
    if (text.trim()) {
      console.error(`[download:${name}] ${text.trimEnd()}`);
    }
  });

  child.on('close', (code) => {
    lineBuffer.flush();
    const wasCancelled = _active?.cancelled;
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
        downloadState.updateDownload(id, {
          status: 'failed',
          errorCode: 'PROCESS_EXIT',
          errorMessage: `Python exited with code ${code}`,
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
