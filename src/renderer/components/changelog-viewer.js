'use strict';

/**
 * Changelog viewer — modal launched from About → Version history.
 *
 * List view shows every `changelog/v*.md` entry (sorted newest first).
 * Clicking a version loads that markdown and renders it via the shared
 * markdown-render.js (same renderer used by the update dialog).
 */

import { t, onLanguageChanged } from '../lib/i18n.js';
import { showToast } from './toast.js';
import { renderMarkdown } from '../lib/markdown-render.js';

const RELEASES_BASE_URL = 'https://github.com/swiftruru/whisperflow-studio/releases/tag/';

let initialized = false;
let entries = [];
let currentVersion = null;

const overlay = () => document.getElementById('changelog-dialog');
const listEl = () => document.getElementById('changelog-list');
const entryEl = () => document.getElementById('changelog-entry');
const entryVersionEl = () => document.getElementById('changelog-entry-version');
const entryBodyEl = () => document.getElementById('changelog-entry-body');
const statusEl = () => document.getElementById('changelog-status');
const closeBtn = () => document.getElementById('btn-changelog-close');
const backBtn = () => document.getElementById('btn-changelog-back');
const githubBtn = () => document.getElementById('btn-changelog-github');

function showStatus(message) {
  const el = statusEl();
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function renderList() {
  const list = listEl();
  if (!list) return;
  list.innerHTML = '';
  if (entries.length === 0) {
    showStatus(t('changelog:list.empty'));
    return;
  }
  showStatus('');
  for (const entry of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'changelog-list-item';
    btn.dataset.version = entry.version;
    const label = document.createElement('span');
    label.className = 'changelog-list-item-version';
    label.textContent = entry.version;
    btn.appendChild(label);
    btn.addEventListener('click', () => openEntry(entry.version));
    list.appendChild(btn);
  }
}

function showListView() {
  currentVersion = null;
  entryEl().hidden = true;
  listEl().hidden = false;
}

function showEntryView() {
  listEl().hidden = true;
  entryEl().hidden = false;
}

async function loadEntries() {
  try {
    showStatus(t('changelog:list.loading'));
    entries = await window.electronAPI.changelog.list();
    renderList();
  } catch (err) {
    entries = [];
    showStatus(t('changelog:list.failed', { error: err?.message || String(err) }));
  }
}

async function openEntry(version) {
  currentVersion = version;
  showEntryView();
  entryVersionEl().textContent = version;
  entryBodyEl().textContent = t('changelog:view.loading', { version });
  try {
    const source = await window.electronAPI.changelog.read(version);
    renderMarkdown(source, entryBodyEl());
  } catch (err) {
    entryBodyEl().textContent = t('changelog:view.failed', {
      version,
      error: err?.message || String(err),
    });
  }
}

function handleGithub() {
  if (!currentVersion) return;
  const url = `${RELEASES_BASE_URL}${currentVersion}`;
  window.electronAPI.openExternal(url).catch((err) => {
    showToast(
      t('changelog:view.failed', { version: currentVersion, error: err?.message || String(err) }),
      'error',
      4000,
    );
  });
}

function closeDialog() {
  const o = overlay();
  if (o) o.hidden = true;
}

function openDialog() {
  const o = overlay();
  if (!o) return;
  o.hidden = false;
  showListView();
  loadEntries();
}

function initChangelogViewer() {
  if (initialized) return;
  const o = overlay();
  if (!o) return;
  initialized = true;

  closeBtn()?.addEventListener('click', closeDialog);
  backBtn()?.addEventListener('click', showListView);
  githubBtn()?.addEventListener('click', handleGithub);

  o.addEventListener('click', (event) => {
    if (event.target === o) closeDialog();
  });

  document.addEventListener('keydown', (event) => {
    if (o.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (currentVersion) {
        showListView();
      } else {
        closeDialog();
      }
    }
  });

  onLanguageChanged(() => {
    if (o.hidden) return;
    if (currentVersion) {
      entryBodyEl().textContent = t('changelog:view.loading', { version: currentVersion });
      openEntry(currentVersion);
    } else {
      renderList();
    }
  });
}

export { initChangelogViewer, openDialog as openChangelogViewer };
