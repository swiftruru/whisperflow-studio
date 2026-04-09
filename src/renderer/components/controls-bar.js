'use strict';

import { saveSettings, collectFormValues, renderSettings } from './settings-panel.js';
import { setStatus } from './console-log.js';
import { showToast } from './toast.js';
import { addHistoryEntry } from './history.js';
import { getPreflightState, refreshPreflight, subscribePreflight } from './preflight-panel.js';

const btnScan = document.getElementById('btn-scan');
const btnCli = document.getElementById('btn-run-cli');
const btnStop = document.getElementById('btn-stop');
const chkLoop = document.getElementById('chk-auto-loop');
const actionHint = document.getElementById('action-hint');

let lastAction = null;
let isRunning = false;

function getBlockingMessage() {
  const preflight = getPreflightState();
  if (preflight.pending) return '正在檢查環境設定…';
  return preflight.blockingChecks[0]?.message || '';
}

function syncActionState() {
  const preflight = getPreflightState();
  const isBlocked = preflight.pending || !preflight.ok;

  btnScan.disabled = isRunning || isBlocked;
  btnCli.disabled = isRunning || isBlocked;
  btnStop.disabled = !isRunning;
  btnScan.classList.toggle('spinning', isRunning && lastAction === 'scan');

  const reason = isRunning ? '' : getBlockingMessage();
  if (actionHint) {
    actionHint.hidden = !reason;
    actionHint.textContent = reason;
  }
  btnScan.title = reason || 'Scan for missing subtitles';
  btnCli.title = reason || 'Run transcription';

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

async function ensurePreflightReady() {
  await saveSettings();
  const preflight = await refreshPreflight();
  if (preflight.ok) return true;

  showToast('請先修正環境設定後再執行', 'error');
  syncActionState();
  return false;
}

btnScan.addEventListener('click', async () => {
  const isReady = await ensurePreflightReady();
  if (!isReady) return;

  const values = collectFormValues();
  const rootPath = values?.SETTING?.media_root_path || '';
  lastAction = 'scan';
  setRunning(true);
  window.electronAPI.runScan(rootPath || undefined);
});

btnCli.addEventListener('click', async () => {
  const isReady = await ensurePreflightReady();
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
    const config = await window.electronAPI.readConfig().catch(() => null);
    if (config) {
      const card = document.getElementById('found-card');
      const fname = document.getElementById('found-filename');
      const fpath = document.getElementById('found-filepath');
      const badge = document.getElementById('missing-count-badge');
      const name = config?.SETTING?.media_file_name || '';
      const mediaPath = config?.SETTING?.media_file_path || '';
      const count = config?.SETTING?.missing_count ?? 0;

      if (name && name.trim()) {
        fname.textContent = name.trim();
        fpath.textContent = mediaPath.trim();
        if (badge) {
          badge.textContent = `共 ${count} 個待轉錄`;
          badge.hidden = false;
        }
        card.hidden = false;
        card.classList.remove('animate-in');
        requestAnimationFrame(() => card.classList.add('animate-in'));
        showToast(`找到：${name.trim()}（共 ${count} 個）`, 'success');

        if (chkLoop.checked) {
          lastAction = 'cli';
          setRunning(true);
          window.electronAPI.runCli();
          return;
        }
      } else {
        card.hidden = true;
        if (badge) badge.hidden = true;
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
  }

  if (lastAction === 'cli') {
    if (code === 0) {
      showToast('Transcription complete!', 'success');
      window.electronAPI.notify({ title: 'WhisperFlow Studio', body: '轉錄完成！字幕已生成。' });

      const cfg = await window.electronAPI.readConfig().catch(() => null);
      const fileName = cfg?.SETTING?.media_file_name || '';
      const filePath = cfg?.SETTING?.media_file_path || '';
      if (fileName) addHistoryEntry({ fileName, filePath, success: true });

      if (chkLoop.checked) {
        showToast('自動循環：掃描下一個檔案…', 'info', 2000);
        const values = collectFormValues();
        const rootPath = values?.SETTING?.media_root_path || '';
        lastAction = 'scan';
        setRunning(true);
        window.electronAPI.runScan(rootPath || undefined);
      }
    } else if (code !== -2) {
      showToast('Transcription failed', 'error');
      window.electronAPI.notify({ title: 'WhisperFlow Studio', body: '轉錄失敗，請查看 Console 的錯誤訊息。' });

      const cfg = await window.electronAPI.readConfig().catch(() => null);
      const fileName = cfg?.SETTING?.media_file_name || '';
      const filePath = cfg?.SETTING?.media_file_path || '';
      if (fileName) addHistoryEntry({ fileName, filePath, success: false });
    }
  }
});

syncActionState();

export { setRunning };
