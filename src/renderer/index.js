import { renderSettings, collectFormValues } from './components/settings-panel.js';
import { openSearch } from './components/console-log.js';
import { initProfileSwitcher } from './components/profile-switcher.js';
import { initHistory } from './components/history.js';
import './components/controls-bar.js';

// ── Theme toggle ──────────────────────────────────────────────────────────────
function initTheme() {
  const html = document.documentElement;
  const btn = document.getElementById('btn-theme-toggle');
  const moonIcon = document.getElementById('theme-icon-moon');
  const sunIcon = document.getElementById('theme-icon-sun');

  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved ? saved === 'dark' : prefersDark;

  function applyTheme(dark) {
    if (dark) {
      html.removeAttribute('data-theme');
      moonIcon.hidden = false;
      sunIcon.hidden = true;
    } else {
      html.setAttribute('data-theme', 'light');
      moonIcon.hidden = true;
      sunIcon.hidden = false;
    }
  }

  applyTheme(isDark);

  btn.addEventListener('click', () => {
    const currentlyDark = !html.hasAttribute('data-theme');
    applyTheme(!currentlyDark);
    localStorage.setItem('theme', currentlyDark ? 'light' : 'dark');
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.toggle('active', b === btn));
      tabPanes.forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));
    });
  });
}

// ── Directory display ─────────────────────────────────────────────────────────
function updateDirDisplay(rootPath) {
  const pathText = document.getElementById('dir-path-text');
  const guide    = document.getElementById('step-guide');
  if (rootPath && rootPath.trim()) {
    pathText.textContent = rootPath.trim();
    pathText.classList.remove('empty');
    if (guide) guide.hidden = true;
  } else {
    pathText.textContent = 'Drag a folder here, or click Browse…';
    pathText.classList.add('empty');
    if (guide) guide.hidden = false;
  }
}

async function refreshDirDisplay() {
  const config = await window.electronAPI.readConfig().catch(() => null);
  const rootPath = config?.SETTING?.media_root_path || '';
  updateDirDisplay(rootPath);
  refreshFoundFileDisplay(config);
}

function refreshFoundFileDisplay(config) {
  const card  = document.getElementById('found-card');
  const fname = document.getElementById('found-filename');
  const fpath = document.getElementById('found-filepath');
  const name  = config?.SETTING?.media_file_name || '';
  const path  = config?.SETTING?.media_file_path || '';

  if (name && name.trim()) {
    fname.textContent = name.trim();
    fpath.textContent = path.trim();
    card.hidden = false;
  } else {
    card.hidden = true;
  }
}

// ── Recent directories ────────────────────────────────────────────────────────
const RECENT_DIRS_KEY = 'recentDirs';
const RECENT_DIRS_MAX = 5;

function getRecentDirs() {
  try { return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY)) || []; }
  catch (_) { return []; }
}

function saveRecentDir(folder) {
  const dirs = getRecentDirs().filter(d => d !== folder);
  dirs.unshift(folder);
  if (dirs.length > RECENT_DIRS_MAX) dirs.length = RECENT_DIRS_MAX;
  localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs));
}

function renderRecentDirs() {
  const list = document.getElementById('recent-dirs-list');
  if (!list) return;
  const dirs = getRecentDirs();
  if (dirs.length === 0) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  list.innerHTML = '';
  dirs.forEach(dir => {
    const btn = document.createElement('button');
    btn.className = 'recent-dir-item';
    btn.title = dir;
    // Show only last 2 path segments for readability
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    const label = parts.length > 1 ? `…/${parts.slice(-2).join('/')}` : dir;
    btn.textContent = label;
    btn.addEventListener('click', () => applyDirectory(dir));
    list.appendChild(btn);
  });
}

function initRecentDirs() {
  renderRecentDirs();
}

// ── Shared: apply directory path ──────────────────────────────────────────────
async function applyDirectory(folder) {
  if (!folder) return;
  updateDirDisplay(folder);
  saveRecentDir(folder);
  renderRecentDirs();
  // Persist to config.ini
  const config = await window.electronAPI.readConfig().catch(() => ({}));
  if (!config.SETTING) config.SETTING = {};
  config.SETTING.media_root_path = folder;
  await window.electronAPI.writeConfig(config);
  // Keep the Settings tab form in sync
  const inputEl = document.querySelector('[data-section="SETTING"][data-key="media_root_path"]');
  if (inputEl) inputEl.value = folder;
}

// ── Browse button ─────────────────────────────────────────────────────────────
function initBrowseDir() {
  document.getElementById('btn-browse-dir').addEventListener('click', async () => {
    const folder = await window.electronAPI.browseFolder();
    if (folder) await applyDirectory(folder);
  });
}

// ── Drag-and-drop onto the directory card ─────────────────────────────────────
function initDragDrop() {
  const dirCard = document.querySelector('.dir-card');

  // Prevent browser from navigating to the file
  dirCard.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dirCard.classList.add('drag-over');
  });

  dirCard.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dirCard.classList.add('drag-over');
  });

  dirCard.addEventListener('dragleave', (e) => {
    // Only remove when leaving the card itself, not a child element
    if (!dirCard.contains(e.relatedTarget)) {
      dirCard.classList.remove('drag-over');
    }
  });

  dirCard.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dirCard.classList.remove('drag-over');

    const items = e.dataTransfer.items;
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Electron 32+: webUtils.getPathForFile() replaces the deprecated file.path
    const droppedPath = window.electronAPI.getPathForFile(files[0]);
    if (!droppedPath) return;

    // Check if the dropped item is a directory via webkitGetAsEntry
    const entry = items[0]?.webkitGetAsEntry?.();
    if (entry && entry.isDirectory) {
      // Dropped a folder directly → use it as-is
      await applyDirectory(droppedPath);
    } else {
      // Dropped a file → use its containing directory
      const sep = droppedPath.includes('/') ? '/' : '\\';
      const parentDir = droppedPath.substring(0, droppedPath.lastIndexOf(sep));
      await applyDirectory(parentDir || droppedPath);
    }
  });
}

// ── After scan: refresh found file card ───────────────────────────────────────
export function onScanComplete() {
  refreshDirDisplay();
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
function initKeyboardShortcuts() {
  const shortcutsModal = document.getElementById('shortcuts-modal');
  document.getElementById('btn-shortcuts-close').addEventListener('click', () => {
    shortcutsModal.hidden = true;
  });
  shortcutsModal.addEventListener('click', (e) => {
    if (e.target === shortcutsModal) shortcutsModal.hidden = true;
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const tag = e.target.tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (mod && e.key === 's') {
      e.preventDefault();
      const settingsPane = document.getElementById('tab-settings');
      if (settingsPane.classList.contains('active')) {
        document.getElementById('btn-save-settings').click();
      }
    }
    if (mod && e.key === 'k') {
      e.preventDefault();
      document.getElementById('btn-clear-log').click();
    }
    if (mod && e.key === 'f') {
      e.preventDefault();
      openSearch();
    }
    if (e.key === '?' && !isTyping && !mod) {
      shortcutsModal.hidden = false;
    }
    if (e.key === 'Escape') {
      shortcutsModal.hidden = true;
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  initTheme();
  initTabs();
  initBrowseDir();
  initDragDrop();
  initKeyboardShortcuts();
  initRecentDirs();
  await renderSettings();
  await refreshDirDisplay();
  await initProfileSwitcher();
  await initHistory();
}

init();
