'use strict';

import { saveSettings, collectFormValues, renderSettings } from './settings-panel.js';
import { setStatus } from './console-log.js';
import { showToast } from './toast.js';
import { addHistoryEntry } from './history.js';

const btnScan    = document.getElementById('btn-scan');
const btnCli     = document.getElementById('btn-run-cli');
const btnStop    = document.getElementById('btn-stop');
const chkLoop    = document.getElementById('chk-auto-loop');

let _lastAction = null;

function setRunning(running) {
  btnScan.disabled = running;
  btnCli.disabled  = running;
  btnStop.disabled = !running;
  btnScan.classList.toggle('spinning', running && _lastAction === 'scan');
  setStatus(running ? 'Running' : 'Idle');
  window.electronAPI.setRunning(running);
  document.title = running ? '● Running — WhisperFlow Studio' : 'WhisperFlow Studio';
}

btnScan.addEventListener('click', async () => {
  await saveSettings();
  const values = collectFormValues();
  const rootPath = values?.SETTING?.media_root_path || '';
  _lastAction = 'scan';
  setRunning(true);
  window.electronAPI.runScan(rootPath || undefined);
});

btnCli.addEventListener('click', async () => {
  await saveSettings();
  _lastAction = 'cli';
  setRunning(true);
  window.electronAPI.runCli();
});

btnStop.addEventListener('click', () => {
  window.electronAPI.stopProcess();
});

document.getElementById('btn-reveal-in-finder').addEventListener('click', () => {
  const fpath = document.getElementById('found-filepath').textContent.trim();
  if (fpath) window.electronAPI.showInFolder(fpath);
});

window.electronAPI.onRunDone(async (code) => {
  setRunning(false);
  if (code !== 0 && code !== -2) {
    setStatus('Error');
  }
  // After scan completes, refresh the found file card on main tab
  if (_lastAction === 'scan') {
    const config = await window.electronAPI.readConfig().catch(() => null);
    if (config) {
      const card   = document.getElementById('found-card');
      const fname  = document.getElementById('found-filename');
      const fpath  = document.getElementById('found-filepath');
      const badge  = document.getElementById('missing-count-badge');
      const name   = config?.SETTING?.media_file_name || '';
      const path   = config?.SETTING?.media_file_path || '';
      const count  = config?.SETTING?.missing_count ?? 0;
      if (name && name.trim()) {
        fname.textContent = name.trim();
        fpath.textContent = path.trim();
        if (badge) {
          badge.textContent = `共 ${count} 個待轉錄`;
          badge.hidden = false;
        }
        card.hidden = false;
        card.classList.remove('animate-in');
        requestAnimationFrame(() => card.classList.add('animate-in'));
        showToast(`找到：${name.trim()}（共 ${count} 個）`, 'success');
        // Auto-loop: immediately run transcription after scan
        if (chkLoop.checked) {
          _lastAction = 'cli';
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
      // Re-render Settings form so it reflects the new config values.
      // Without this, clicking Run Transcription would call saveSettings()
      // and overwrite config.ini with the stale form data (old filename).
      await renderSettings();
    }
  }
  if (_lastAction === 'cli') {
    if (code === 0) {
      showToast('Transcription complete!', 'success');
      window.electronAPI.notify({ title: 'WhisperFlow Studio', body: '轉錄完成！字幕已生成。' });
      // Record to history
      const cfg = await window.electronAPI.readConfig().catch(() => null);
      const fileName = cfg?.SETTING?.media_file_name || '';
      const filePath = cfg?.SETTING?.media_file_path || '';
      if (fileName) addHistoryEntry({ fileName, filePath, success: true });
      // Auto-loop: scan for next file and run again
      if (chkLoop.checked) {
        showToast('自動循環：掃描下一個檔案…', 'info', 2000);
        const values = collectFormValues();
        const rootPath = values?.SETTING?.media_root_path || '';
        _lastAction = 'scan';
        setRunning(true);
        window.electronAPI.runScan(rootPath || undefined);
      }
    } else if (code !== -2) {
      showToast('Transcription failed', 'error');
      window.electronAPI.notify({ title: 'WhisperFlow Studio', body: '轉錄失敗，請查看 Console 的錯誤訊息。' });
      // Record failed transcription
      const cfg = await window.electronAPI.readConfig().catch(() => null);
      const fileName = cfg?.SETTING?.media_file_name || '';
      const filePath = cfg?.SETTING?.media_file_path || '';
      if (fileName) addHistoryEntry({ fileName, filePath, success: false });
    }
  }
});

export { setRunning };
