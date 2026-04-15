'use strict';

// Tag <html> with the host platform so CSS can conditionally reserve space
// for macOS traffic lights (and nothing on Windows/Linux).  Must run before
// first paint, so it lives here in bootstrap.js rather than in index.js.
try {
  const platform = window.electronAPI?.platform || 'unknown';
  document.documentElement.dataset.platform = platform;
} catch (_) {
  document.documentElement.dataset.platform = 'unknown';
}

function appendBootLog(message, type = 'error') {
  const output = document.getElementById('console-output');
  if (!output) return;

  const line = document.createElement('span');
  line.className = `log-line ${type}`;
  line.textContent = message;
  output.appendChild(line);
}

function showBootFailure(error) {
  const message = error?.stack || error?.message || String(error);
  const summary = document.getElementById('preflight-summary');
  const count = document.getElementById('preflight-count');
  const list = document.getElementById('preflight-list');
  const panel = document.getElementById('preflight-panel');
  const status = document.getElementById('status-badge');

  if (panel) panel.hidden = false;
  if (count) count.textContent = '啟動錯誤';
  if (summary) summary.textContent = 'Renderer 啟動失敗，請查看右側 Console。';
  if (list) {
    list.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'preflight-item error';
    row.innerHTML = `
      <span class="preflight-item-icon">!</span>
      <div class="preflight-item-body">
        <div class="preflight-item-title">Renderer 載入失敗</div>
        <div class="preflight-item-message">前端模組初始化時發生錯誤。</div>
        <div class="preflight-item-detail">${message}</div>
      </div>
    `;
    list.appendChild(row);
  }

  if (status) status.textContent = 'Error';
  appendBootLog(`[Renderer bootstrap error] ${message}`, 'error');
}

window.addEventListener('error', (event) => {
  showBootFailure(event.error || new Error(event.message));
});

window.addEventListener('unhandledrejection', (event) => {
  showBootFailure(event.reason || new Error('Unhandled promise rejection'));
});

const indexImportPromise = import('./index.js');
indexImportPromise.catch((error) => {
  showBootFailure(error);
});
