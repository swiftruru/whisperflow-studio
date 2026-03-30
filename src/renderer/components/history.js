'use strict';

const HISTORY_MAX = 10;

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return '剛剛';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

export async function addHistoryEntry({ fileName, filePath, success }) {
  const entries = await window.electronAPI.readHistory().catch(() => []);
  entries.unshift({ fileName, filePath, success, timestamp: new Date().toISOString() });
  if (entries.length > HISTORY_MAX) entries.length = HISTORY_MAX;
  await window.electronAPI.writeHistory(entries);
  renderHistory(entries);
}

export async function initHistory() {
  const entries = await window.electronAPI.readHistory().catch(() => []);
  renderHistory(entries);

  const clearBtn = document.getElementById('btn-clear-history');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      await window.electronAPI.writeHistory([]);
      renderHistory([]);
    });
  }
}

function renderHistory(entries) {
  const section = document.getElementById('history-section');
  const list    = document.getElementById('history-list');
  if (!section || !list) return;

  if (!entries || entries.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.innerHTML = '';

  entries.forEach(entry => {
    const row = document.createElement('div');
    row.className = `history-row ${entry.success ? 'ok' : 'fail'}`;

    const icon = document.createElement('span');
    icon.className = 'history-icon';
    icon.textContent = entry.success ? '✓' : '✗';

    const info = document.createElement('div');
    info.className = 'history-info';

    const name = document.createElement('span');
    name.className = 'history-name';
    name.textContent = entry.fileName || '未知檔案';
    name.title = entry.filePath || '';

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = entry.timestamp ? timeAgo(entry.timestamp) : '';

    info.appendChild(name);
    info.appendChild(time);
    row.appendChild(icon);
    row.appendChild(info);
    list.appendChild(row);
  });
}
