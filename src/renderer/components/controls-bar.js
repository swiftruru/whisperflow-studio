'use strict';

import { saveSettings, collectFormValues, renderSettings } from './settings-panel.js';
import { setStatus } from './console-log.js';
import { showToast } from './toast.js';
import { addHistoryEntry } from './history.js';
import { getPreflightState, refreshPreflight, subscribePreflight } from './preflight-panel.js';
import { getQueueState } from './queue-state.js';

const btnScan = document.getElementById('btn-scan');
const btnCli = document.getElementById('btn-run-cli');
const btnStop = document.getElementById('btn-stop');
const chkLoop = document.getElementById('chk-auto-loop');
const actionHint = document.getElementById('action-hint');

let lastAction = null;
let isRunning = false;

function getCheck(key) {
  const preflight = getPreflightState();
  return preflight.checks.find((check) => check.key === key) || null;
}

function getScanBlockingMessage() {
  const preflight = getPreflightState();
  if (preflight.pending) return '正在檢查環境設定…';
  const mediaRootCheck = getCheck('media_root_path');
  return mediaRootCheck?.status === 'error' ? mediaRootCheck.message : '';
}

function getRunBlockingMessage() {
  const preflight = getPreflightState();
  if (preflight.pending) return '正在檢查環境設定…';
  return preflight.blockingChecks[0]?.message || '';
}

function syncActionState() {
  const preflight = getPreflightState();
  const scanBlocked = preflight.pending || Boolean(getScanBlockingMessage());
  const runBlocked = preflight.pending || !preflight.ok;

  btnScan.disabled = isRunning || scanBlocked;
  btnCli.disabled = isRunning || runBlocked;
  btnStop.disabled = !isRunning;
  btnScan.classList.toggle('spinning', isRunning && lastAction === 'scan');

  const reason = isRunning ? '' : (getScanBlockingMessage() || getRunBlockingMessage());
  if (actionHint) {
    actionHint.hidden = !reason;
    actionHint.textContent = reason;
  }
  btnScan.title = getScanBlockingMessage() || 'Scan for missing subtitles';
  btnCli.title = getRunBlockingMessage() || 'Run transcription';

  if (!isRunning) {
    setStatus(preflight.pending ? 'Checking' : (preflight.ok ? 'Idle' : 'Setup'));
    document.title = 'WhisperFlow Studio';
  }
}

function setRunning(running) {
  isRunning = running;
  window.electronAPI.setRunning(running);

  if (running) {
    setStatus('Running');
    document.title = '● Running — WhisperFlow Studio';
  }

  syncActionState();
}

async function ensureScanReady() {
  await saveSettings();
  const preflight = await refreshPreflight();
  const mediaRootCheck = preflight.checks.find((check) => check.key === 'media_root_path');

  if (mediaRootCheck?.status !== 'error') return true;

  showToast('請先設定有效的媒體資料夾後再掃描', 'error');
  syncActionState();
  return false;
}

async function ensureRunReady() {
  await saveSettings();
  const preflight = await refreshPreflight();
  if (preflight.ok) return true;

  showToast('請先修正環境設定後再執行', 'error');
  syncActionState();
  return false;
}

btnScan.addEventListener('click', async () => {
  const isReady = await ensureScanReady();
  if (!isReady) return;

  const values = collectFormValues();
  const rootPath = values?.SETTING?.media_root_path || '';
  lastAction = 'scan';
  setRunning(true);
  window.electronAPI.runScan(rootPath || undefined);
});

btnCli.addEventListener('click', async () => {
  const isReady = await ensureRunReady();
  if (!isReady) return;

  lastAction = 'cli';
  setRunning(true);
  window.electronAPI.runCli();
});

btnStop.addEventListener('click', () => {
  window.electronAPI.stopProcess();
});

document.getElementById('btn-reveal-in-finder').addEventListener('click', () => {
  const filePath = document.getElementById('found-filepath').textContent.trim();
  if (filePath) window.electronAPI.showInFolder(filePath);
});

subscribePreflight(() => {
  if (!isRunning) syncActionState();
});

window.electronAPI.onRunDone(async (code) => {
  setRunning(false);
  if (code !== 0 && code !== -2) {
    setStatus('Error');
  }

  if (lastAction === 'scan') {
    const queueState = getQueueState();
    const preflight = getPreflightState();

    if (queueState.stats.total > 0 && queueState.currentJob) {
      showToast(`找到：${queueState.currentJob.fileName}（共 ${queueState.stats.total} 個）`, 'success');
      if (chkLoop.checked && preflight.ok) {
        lastAction = 'cli';
        setRunning(true);
        window.electronAPI.runCli();
        return;
      }
      if (chkLoop.checked && !preflight.ok) {
        showToast('掃描完成，但轉錄前仍需先修正環境設定', 'info');
      }
    } else {
      if (chkLoop.checked) {
        showToast('自動循環完成：所有檔案已轉錄', 'success');
        window.electronAPI.notify({ title: 'WhisperFlow Studio', body: '所有檔案已轉錄完成！' });
      } else {
        showToast('未找到缺字幕的媒體檔案', 'info');
      }
    }

    await renderSettings();
    await refreshPreflight();
  }

  if (lastAction === 'cli') {
    const queueState = getQueueState();
    const finishedJob = queueState.lastFinishedJob;

    if (code === 0) {
      showToast('Transcription complete!', 'success');
      window.electronAPI.notify({ title: 'WhisperFlow Studio', body: '轉錄完成！字幕已生成。' });

      if (finishedJob?.fileName) {
        addHistoryEntry({
          fileName: finishedJob.fileName,
          filePath: finishedJob.filePath,
          success: true,
        });
      }

      if (chkLoop.checked && queueState.stats.pending > 0) {
        showToast('自動循環：處理下一個檔案…', 'info', 2000);
        lastAction = 'cli';
        setRunning(true);
        window.electronAPI.runCli();
      } else if (chkLoop.checked) {
        showToast('自動循環完成：佇列已全部處理', 'success');
      }
    } else if (code !== -2) {
      showToast('Transcription failed', 'error');
      window.electronAPI.notify({ title: 'WhisperFlow Studio', body: '轉錄失敗，請查看 Console 的錯誤訊息。' });

      if (finishedJob?.fileName) {
        addHistoryEntry({
          fileName: finishedJob.fileName,
          filePath: finishedJob.filePath,
          success: false,
        });
      }
    }

    await renderSettings();
  }
});

syncActionState();

export { setRunning };
