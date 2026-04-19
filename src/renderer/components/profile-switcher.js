'use strict';

/**
 * Profile manager — save/switch/rename/delete multiple config.json
 * profiles stored as subdirectories under python/config/.  Each profile
 * is a complete TranscribeConfig snapshot (language, model, VAD, etc.).
 *
 * Lives in Settings > Transcription.  The profile picker uses the
 * shared themed-select component so it matches every other dropdown in
 * the app; rename/delete are low-weight link buttons below.  The
 * "save current as new profile" button only appears when the settings
 * form has unsaved changes — see the settings:dirty-changed event.
 */

import { renderSettings, buildMergedConfigFromForm, clearDirty } from './settings-panel.js';
import { showToast } from './toast.js';
import { confirmDialog } from '../lib/confirm-dialog.js';
import { t } from '../lib/i18n.js';
import { createThemedSelect } from '../lib/themed-select.js';

let _profiles = [];
let _activeProfile = 'default';
let _dropdown = null;

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

function findActiveProfile() {
  return _profiles.find((p) => p.name === _activeProfile) || null;
}

async function handleCreate() {
  const name = await promptForName({
    title: t('dialogs:profile.create.title'),
    placeholder: t('dialogs:profile.namePlaceholder'),
  });
  if (!name) return;
  try {
    // Seed the new profile with the CURRENT in-memory form state
    // (including unsaved edits) — that's the whole point of the "Save
    // current as new profile" flow.  Previously the backend only copied
    // the persisted config.json, so unsaved tweaks vanished into the
    // ether and the dropdown snapped back to the prior profile.
    const seed = await buildMergedConfigFromForm();
    const created = await window.electronAPI.createProfile(name, seed);
    // Point the active profile at the newly created one so backend
    // state, dropdown, and form agree.  loadProfile copies the new
    // profile's config.json into the active slot — effectively a
    // no-op valuewise since we just seeded it with the form state —
    // but it keeps main process tracking consistent.
    await window.electronAPI.loadProfile(created.configPath);
    _activeProfile = created.name;
    showToast(t('dialogs:profile.toast.created', { name }), 'success', 2500);
    await refreshProfiles();
    await renderSettings();
    // The form now matches the freshly saved profile → clear dirty
    // explicitly so the hint banner and save badge both reset.
    clearDirty();
  } catch (err) {
    showToast(errorMessageForCode(err?.code) || err?.message || String(err), 'error', 4000);
  }
}

async function handleRename() {
  const profile = findActiveProfile();
  if (!profile || profile.name === 'default') return;
  const newName = await promptForName({
    title: t('dialogs:profile.rename.title', { name: profile.name }),
    placeholder: t('dialogs:profile.namePlaceholder'),
    initialValue: profile.name,
  });
  if (!newName || newName === profile.name) return;
  try {
    await window.electronAPI.renameProfile(profile.name, newName);
    _activeProfile = newName;
    showToast(t('dialogs:profile.toast.renamed', { from: profile.name, to: newName }), 'success', 2500);
    await refreshProfiles();
  } catch (err) {
    showToast(errorMessageForCode(err?.code) || err?.message || String(err), 'error', 4000);
  }
}

async function handleDelete() {
  const profile = findActiveProfile();
  if (!profile || profile.name === 'default') return;
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

function isSettingsDirty() {
  return !!document.getElementById('btn-save-settings')?.classList.contains('dirty');
}

async function switchProfile(name) {
  if (name === _activeProfile) return;
  const profile = _profiles.find((p) => p.name === name);
  if (!profile) return;

  // If the settings form has unsaved edits, loading a different profile
  // would silently overwrite those edits with the other profile's
  // values — no undo.  Confirm first, and revert the dropdown if the
  // user backs out so the UI stays truthful about which profile is
  // actually loaded.
  if (isSettingsDirty()) {
    const confirmed = await confirmDialog({
      title: t('dialogs:profile.switchDirty.title'),
      message: t('dialogs:profile.switchDirty.message', { name: profile.name }),
      confirmText: t('dialogs:profile.switchDirty.confirm'),
      cancelText: t('dialogs:profile.switchDirty.cancel'),
      destructive: true,
    });
    if (!confirmed) {
      _dropdown?.setValue(_activeProfile);
      return;
    }
  }

  await window.electronAPI.loadProfile(profile.configPath);
  _activeProfile = profile.name;
  syncMetaButtons();
  await renderSettings();
}

function syncMetaButtons() {
  const btnRename = document.getElementById('btn-profile-rename');
  const btnDelete = document.getElementById('btn-profile-delete');
  const isDefault = _activeProfile === 'default';
  if (btnRename) btnRename.disabled = isDefault;
  if (btnDelete) btnDelete.disabled = isDefault;
}

function renderDropdown() {
  const mount = document.getElementById('profile-dropdown-mount');
  if (!mount) return;
  const options = _profiles.map((p) => ({ value: p.name, label: p.name }));
  if (!_dropdown) {
    _dropdown = createThemedSelect({
      options,
      value: _activeProfile,
      ariaLabelledBy: 'profile-dropdown-label',
      onChange: (name) => { switchProfile(name); },
    });
    mount.innerHTML = '';
    mount.appendChild(_dropdown);
  } else {
    _dropdown.setOptions(options, { preserveValue: false });
    _dropdown.setValue(_activeProfile);
  }
  syncMetaButtons();
}

async function refreshProfiles() {
  try {
    _profiles = await window.electronAPI.listProfiles();
  } catch (_) {
    _profiles = [];
  }
  renderDropdown();
}

async function initProfileSwitcher() {
  await refreshProfiles();

  document.getElementById('btn-profile-create')?.addEventListener('click', handleCreate);
  document.getElementById('btn-profile-rename')?.addEventListener('click', handleRename);
  document.getElementById('btn-profile-delete')?.addEventListener('click', handleDelete);

  // Hide the "Save as new profile" row by default; show only when the
  // user has unsaved changes.  This avoids visually nudging users toward
  // creating profiles they don't need, and keeps the dropdown area calm.
  const dirtyRow = document.getElementById('settings-profile-dirty-row');
  const syncDirty = (dirty) => {
    if (dirtyRow) dirtyRow.hidden = !dirty;
  };
  syncDirty(document.getElementById('btn-save-settings')?.classList.contains('dirty'));
  window.addEventListener('settings:dirty-changed', (e) => {
    syncDirty(!!e.detail?.dirty);
  });
}

export { initProfileSwitcher };
