import { renderSettings, initSettingsSegments } from './components/settings-panel.js';
import { openSearch } from './components/console-log.js';
import { triggerRun, triggerScan, hydrateLatestTranscriptFromHistory } from './components/controls-bar.js';
import { initProfileSwitcher } from './components/profile-switcher.js';
import { initHistory } from './components/history.js';
import { initPreflightPanel, refreshPreflight } from './components/preflight-panel.js';
import { initErrorState } from './components/error-state.js';
import { initErrorBanner } from './components/error-banner.js';
import { initErrorDialog } from './components/error-dialog.js';
import { initInstallFfmpegDialog } from './components/install-ffmpeg-dialog.js';
import { initLanguageToggle } from './components/language-toggle.js';
import { initAboutPanel } from './components/about-panel.js';
import { initHelpPanel } from './components/help-panel.js';
import { maybeRunFirstLaunchTour } from './components/onboarding-tour.js';
import { initUpdateDialog } from './components/update-dialog.js';
import { initRendererI18n } from './lib/i18n.js';
import { applyTranslations } from './lib/i18n-dom.js';
import { initQueueState } from './components/queue-state.js';
import { initQueuePanel } from './components/queue-panel.js';
import { initModelManager } from './components/model-manager.js';
import { initDownloadState } from './components/download-state.js';
import { initDownloadPanel } from './components/download-panel.js';
import { initDownloadIndicator } from './components/download-indicator.js';
import { showToast } from './components/toast.js';
import { t } from './lib/i18n.js';
import { initA11yControls } from './lib/a11y.js';
import {
  initKeyboardShortcuts as initCustomKeyboardShortcuts,
  registerShortcutAction,
} from './lib/shortcuts.js';
import { initShortcutsPanel } from './components/shortcuts-panel.js';
import { initTranscriptAutoOpenToggle } from './components/transcript-preview.js';
import { initSubtitleEditor } from './components/subtitle-editor.js';
import './components/controls-bar.js';

// ── Theme toggle ──────────────────────────────────────────────────────────────
function initTheme() {
  const html = document.documentElement;
  const btn = document.getElementById('btn-theme-toggle');
  const moonIcon = document.getElementById('theme-icon-moon');
  const sunIcon = document.getElementById('theme-icon-sun');

  const saved = localStorage.getItem('theme');
  // First launch (no saved preference): default to light, not OS preference.
  const isDark = saved ? saved === 'dark' : false;

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
  const appShell = document.querySelector('.app-shell');

  function applyActiveTab(target) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
    tabPanes.forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));
    // Expose active tab so CSS can collapse the right-side Console on
    // tabs that don't benefit from it (Settings, About).
    if (appShell) appShell.dataset.activeTab = target;
  }

  // Initial state — reflect whichever tab is `.active` in markup.
  const activePane = document.querySelector('.tab-pane.active');
  if (activePane && appShell) {
    appShell.dataset.activeTab = activePane.id.replace(/^tab-/, '');
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      applyActiveTab(btn.dataset.tab);
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

function setRecentPopoverOpen(open) {
  const popover = document.getElementById('recent-dirs-list');
  const trigger = document.getElementById('btn-browse-recent');
  if (!popover || !trigger) return;
  popover.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
}

// Drop stale entries (folder deleted / renamed since last use) so the
// user never picks one that would immediately fail preflight.
async function pruneStaleRecentDirs() {
  const dirs = getRecentDirs();
  if (dirs.length === 0) return dirs;
  if (!window.electronAPI?.filterExistingDirs) return dirs;
  try {
    const existing = await window.electronAPI.filterExistingDirs(dirs);
    const kept = dirs.filter((d) => existing.includes(d));
    if (kept.length !== dirs.length) {
      localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(kept));
    }
    return kept;
  } catch (_) {
    return dirs;
  }
}

function renderRecentDirs() {
  const popover = document.getElementById('recent-dirs-list');
  const trigger = document.getElementById('btn-browse-recent');
  if (!popover || !trigger) return;
  const dirs = getRecentDirs();
  if (dirs.length === 0) {
    trigger.hidden = true;
    setRecentPopoverOpen(false);
    return;
  }
  trigger.hidden = false;
  popover.innerHTML = '';
  dirs.forEach(dir => {
    const btn = document.createElement('button');
    btn.className = 'recent-dir-item';
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.title = dir;
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    const label = parts.length > 1 ? `…/${parts.slice(-2).join('/')}` : dir;
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      setRecentPopoverOpen(false);
      await applyDirectory(dir);
    });
    popover.appendChild(btn);
  });
}

function initRecentDirs() {
  const trigger = document.getElementById('btn-browse-recent');
  const popover = document.getElementById('recent-dirs-list');
  if (trigger && popover) {
    trigger.addEventListener('click', async (e) => {
      e.stopPropagation();
      const willOpen = popover.hidden;
      if (willOpen) {
        await pruneStaleRecentDirs();
        renderRecentDirs();
        // pruneStaleRecentDirs may leave zero entries — renderRecentDirs
        // will have hidden the trigger, so bail out without opening an
        // empty popover.
        if (trigger.hidden) return;
      }
      setRecentPopoverOpen(willOpen);
    });
    // Dismiss on outside click and Escape
    document.addEventListener('click', (e) => {
      if (popover.hidden) return;
      if (popover.contains(e.target) || trigger.contains(e.target)) return;
      setRecentPopoverOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !popover.hidden) setRecentPopoverOpen(false);
    });
  }
  renderRecentDirs();
  // Best-effort prune at startup so the chevron reflects the real
  // number of usable entries before the user clicks.
  pruneStaleRecentDirs().then(renderRecentDirs).catch(() => {});
}

// ── Shared: apply directory path ──────────────────────────────────────────────
async function applyDirectory(folder) {
  if (!folder) return;
  updateDirDisplay(folder);
  saveRecentDir(folder);
  renderRecentDirs();
  // Persist to python/config/config.json
  const config = await window.electronAPI.readConfig().catch(() => ({}));
  if (!config.SETTING) config.SETTING = {};
  config.SETTING.media_root_path = folder;
  await window.electronAPI.writeConfig(config);
  // Keep the Settings tab form in sync
  const inputEl = document.querySelector('[data-section="SETTING"][data-key="media_root_path"]');
  if (inputEl) {
    inputEl.value = folder;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await refreshPreflight();
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

    // Check if the first dropped item is a directory via webkitGetAsEntry
    const firstEntry = items[0]?.webkitGetAsEntry?.();
    if (firstEntry && firstEntry.isDirectory) {
      // Dropped a folder directly → use it as-is
      const droppedPath = window.electronAPI.getPathForFile(files[0]);
      if (droppedPath) await applyDirectory(droppedPath);
      return;
    }

    // Dropped individual files → add them directly to the queue
    const filePaths = [];
    for (let i = 0; i < files.length; i++) {
      const p = window.electronAPI.getPathForFile(files[i]);
      if (p) filePaths.push(p);
    }

    if (filePaths.length === 0) return;

    // Dropping a file onto the media-folder card is an explicit intent
    // to point at that folder, independent of whether the file ends up
    // being added to the queue (it may already be queued or already
    // have subtitles). Update the media-folder UI first, then queue.
    const newRoot = filePaths[0].replace(/[\\/][^\\/]+$/, '');
    if (newRoot) await applyDirectory(newRoot);

    const result = await window.electronAPI.addQueueFiles(filePaths);
    if (result.added > 0) {
      showToast(t('queue:toast.filesAdded', { count: result.added }), 'success');
    } else {
      showToast(t(pickSkippedToastKey(result.skipped)), 'info');
    }
  });
}

// Pick a specific toast message based on why addFiles skipped everything,
// so users see the actual reason instead of a vague catch-all. Falls back
// to the generic key when the reasons are mixed or the skipped payload
// is missing (older IPC shape).
function pickSkippedToastKey(skipped) {
  if (!skipped) return 'queue:toast.filesNoneAdded';
  const reasons = Object.entries(skipped).filter(([, n]) => n > 0);
  if (reasons.length !== 1) return 'queue:toast.filesNoneAdded';
  const [only] = reasons[0];
  if (only === 'hasSubtitle')   return 'queue:toast.filesSkippedHasSubtitle';
  if (only === 'alreadyQueued') return 'queue:toast.filesSkippedAlreadyQueued';
  if (only === 'unsupported')   return 'queue:toast.filesSkippedUnsupported';
  if (only === 'notFound')      return 'queue:toast.filesSkippedNotFound';
  return 'queue:toast.filesNoneAdded';
}

// ── File-association bridge: OS "Open with" events add to the queue ─────────
function initFileAssociationBridge() {
  if (!window.electronAPI?.onFileAssociationOpen) return;
  window.electronAPI.onFileAssociationOpen(async (paths) => {
    if (!Array.isArray(paths) || paths.length === 0) return;
    try {
      const newRoot = paths[0].replace(/[\\/][^\\/]+$/, '');
      if (newRoot) await applyDirectory(newRoot);
      const result = await window.electronAPI.addQueueFiles(paths);
      if (result?.added > 0) {
        showToast(t('queue:toast.filesAdded', { count: result.added }), 'success');
      } else if (result) {
        showToast(t(pickSkippedToastKey(result.skipped)), 'info');
      }
    } catch (err) {
      console.error('[file-association] failed to add files:', err);
    }
  });
}

// ── After scan: refresh found file card ───────────────────────────────────────
export function onScanComplete() {
  refreshDirDisplay();
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
// Customizable user-action bindings live in `src/renderer/lib/shortcuts.js`;
// this function just registers each action handler and wires the
// non-customizable help-modal shortcut ("?").
function initKeyboardShortcuts() {
  const shortcutsModal = document.getElementById('shortcuts-modal');
  document.getElementById('btn-shortcuts-close').addEventListener('click', () => {
    shortcutsModal.hidden = true;
  });
  shortcutsModal.addEventListener('click', (e) => {
    if (e.target === shortcutsModal) shortcutsModal.hidden = true;
  });

  // Register customizable action handlers.
  registerShortcutAction('runTranscription', () => triggerRun());
  registerShortcutAction('scanFiles', () => triggerScan());
  registerShortcutAction('stopBatch', () => {
    const btnStop = document.getElementById('btn-stop');
    if (btnStop && !btnStop.disabled) btnStop.click();
  });
  registerShortcutAction('saveSettings', () => {
    const settingsPane = document.getElementById('tab-settings');
    if (settingsPane?.classList.contains('active')) {
      document.getElementById('btn-save-settings')?.click();
    }
  });
  registerShortcutAction('clearConsole', () => {
    document.getElementById('btn-clear-log')?.click();
  });
  registerShortcutAction('searchConsole', () => openSearch());

  initCustomKeyboardShortcuts();

  // Non-customizable bindings: "?" opens help, Escape closes it.
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const mod = e.metaKey || e.ctrlKey;
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
  // i18n must be ready before any component renders, because components
  // call t() synchronously.  Awaiting here keeps the init flow simple
  // and adds <50ms to boot (one IPC round-trip + JSON parse).
  await initRendererI18n();
  applyTranslations(document.body);
  window.addEventListener('app:language-changed', () => {
    applyTranslations(document.body);
  });
  initLanguageToggle();

  initTheme();
  initA11yControls();
  initShortcutsPanel();
  initTranscriptAutoOpenToggle();
  initSubtitleEditor();
  initTabs();
  initBrowseDir();
  initDragDrop();
  initFileAssociationBridge();
  initKeyboardShortcuts();
  initRecentDirs();
  initErrorState();
  initErrorDialog();
  initInstallFfmpegDialog();
  initUpdateDialog();
  initErrorBanner();
  initPreflightPanel({ onApplyDirectory: applyDirectory });
  await initQueueState();
  initQueuePanel();
  initModelManager();
  await initDownloadState();
  initDownloadPanel();
  initDownloadIndicator();
  await initAboutPanel();
  initHelpPanel();
  initSettingsSegments();
  const startupTasks = [
    refreshPreflight(),
    Promise.resolve().then(() => renderSettings()),
    Promise.resolve().then(() => refreshDirDisplay()),
    Promise.resolve().then(() => initProfileSwitcher()),
    Promise.resolve().then(() => initHistory()),
    Promise.resolve().then(() => hydrateLatestTranscriptFromHistory()),
  ];
  const results = await Promise.allSettled(startupTasks);

  results.forEach((result) => {
    if (result.status === 'rejected') {
      console.error('[WhisperFlow Studio] Startup task failed:', result.reason);
    }
  });

  // First-launch onboarding tour — triggers after everything is ready.
  // Internally checks the `hasSeenOnboarding` flag and defers if
  // preflight is still blocking.  Safe to call every boot; it no-ops
  // for returning users.
  maybeRunFirstLaunchTour();
}

init().catch((error) => {
  console.error('[WhisperFlow Studio] Failed to initialize app:', error);
});
