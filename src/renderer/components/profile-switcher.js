'use strict';

/**
 * Profile switcher — lets users manage multiple config.json profiles
 * stored as subdirectories under python/config/.  A profile represents
 * a complete TranscribeConfig snapshot (language, model, VAD settings,
 * etc.) that can be swapped in with one click.
 *
 * Supports: switch, create (from current config), rename, delete.
 * The 'default' profile is always present and cannot be renamed or deleted.
 */

import { renderSettings } from './settings-panel.js';
import { showToast } from './toast.js';
import { confirmDialog } from '../lib/confirm-dialog.js';
import { t } from '../lib/i18n.js';

let _profiles = [];
let _activeProfile = 'default';

function promptForName({ title, placeholder = '', initialValue = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal confirm-dialog';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h2');
    heading.textContent = title;
    modal.appendChild(heading);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'profile-prompt-input';
    input.placeholder = placeholder;
    input.value = initialValue;
    modal.appendChild(input);

    const hint = document.createElement('p');
    hint.className = 'confirm-dialog-message';
    hint.textContent = t('dialogs:profile.nameHint');
    modal.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary confirm-dialog-btn';
    cancel.textContent = t('dialogs:confirm.cancelLabel');

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn-primary confirm-dialog-btn';
    confirm.textContent = t('dialogs:confirm.confirmLabel');

    actions.appendChild(cancel);
    actions.appendChild(confirm);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    function cleanup(value) {
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(value);
    }

    function submit() {
      const v = input.value.trim();
      if (!v) { cleanup(null); return; }
      cleanup(v);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    }

    cancel.addEventListener('click', () => cleanup(null));
    confirm.addEventListener('click', submit);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
    });
    document.addEventListener('keydown', onKeyDown, true);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => input.focus());
  });
}

function errorMessageForCode(code) {
  switch (code) {
    case 'empty':             return t('dialogs:profile.errors.empty');
    case 'reserved':          return t('dialogs:profile.errors.reserved');
    case 'illegal-characters':return t('dialogs:profile.errors.illegalCharacters');
    case 'too-long':          return t('dialogs:profile.errors.tooLong');
    case 'already-exists':    return t('dialogs:profile.errors.alreadyExists');
    case 'not-found':         return t('dialogs:profile.errors.notFound');
    default:                  return code || '';
  }
}

async function handleCreate() {
  const name = await promptForName({
    title: t('dialogs:profile.create.title'),
    placeholder: t('dialogs:profile.namePlaceholder'),
  });
  if (!name) return;
  try {
    await window.electronAPI.createProfile(name);
    showToast(t('dialogs:profile.toast.created', { name }), 'success', 2500);
    await refreshProfiles();
  } catch (err) {
    showToast(errorMessageForCode(err?.code) || err?.message || String(err), 'error', 4000);
  }
}

async function handleRename(profile) {
  if (profile.name === 'default') return;
  const newName = await promptForName({
    title: t('dialogs:profile.rename.title', { name: profile.name }),
    placeholder: t('dialogs:profile.namePlaceholder'),
    initialValue: profile.name,
  });
  if (!newName || newName === profile.name) return;
  try {
    await window.electronAPI.renameProfile(profile.name, newName);
    showToast(t('dialogs:profile.toast.renamed', { from: profile.name, to: newName }), 'success', 2500);
    await refreshProfiles();
  } catch (err) {
    showToast(errorMessageForCode(err?.code) || err?.message || String(err), 'error', 4000);
  }
}

async function handleDelete(profile) {
  if (profile.name === 'default') return;
  const confirmed = await confirmDialog({
    title: t('dialogs:profile.delete.title'),
    message: t('dialogs:profile.delete.message', { name: profile.name }),
    confirmText: t('dialogs:profile.delete.confirm'),
    destructive: true,
  });
  if (!confirmed) return;
  try {
    await window.electronAPI.deleteProfile(profile.name);
    if (_activeProfile === profile.name) _activeProfile = 'default';
    showToast(t('dialogs:profile.toast.deleted', { name: profile.name }), 'success', 2500);
    await refreshProfiles();
  } catch (err) {
    showToast(errorMessageForCode(err?.code) || err?.message || String(err), 'error', 4000);
  }
}

async function switchProfile(profile) {
  if (profile.name === _activeProfile) return;
  await window.electronAPI.loadProfile(profile.configPath);
  _activeProfile = profile.name;
  renderChips();
  await renderSettings();
}

function renderChips() {
  const container = document.getElementById('profile-switcher-container');
  if (!container) return;
  container.innerHTML = '';
  container.hidden = false;

  for (const profile of _profiles) {
    const wrapper = document.createElement('div');
    wrapper.className = 'profile-chip-wrapper';

    const btn = document.createElement('button');
    btn.className = 'profile-chip' + (profile.name === _activeProfile ? ' active' : '');
    btn.type = 'button';
    btn.textContent = profile.name;
    btn.addEventListener('click', () => switchProfile(profile));
    wrapper.appendChild(btn);

    if (profile.name !== 'default') {
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'profile-chip-action';
      renameBtn.title = t('dialogs:profile.rename.action');
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', (e) => { e.stopPropagation(); handleRename(profile); });
      wrapper.appendChild(renameBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'profile-chip-action profile-chip-action--danger';
      delBtn.title = t('dialogs:profile.delete.action');
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); handleDelete(profile); });
      wrapper.appendChild(delBtn);
    }

    container.appendChild(wrapper);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'profile-chip profile-chip-add';
  addBtn.type = 'button';
  addBtn.title = t('dialogs:profile.create.action');
  addBtn.textContent = '+ ' + t('dialogs:profile.create.label');
  addBtn.addEventListener('click', handleCreate);
  container.appendChild(addBtn);
}

async function refreshProfiles() {
  try {
    _profiles = await window.electronAPI.listProfiles();
  } catch (_) {
    _profiles = [];
  }
  renderChips();
}

async function initProfileSwitcher() {
  await refreshProfiles();

  window.addEventListener('app:language-changed', () => {
    renderChips();
  });
}

export { initProfileSwitcher };
