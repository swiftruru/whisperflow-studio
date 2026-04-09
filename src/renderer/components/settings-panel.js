'use strict';

import { showToast } from './toast.js';

let _configObj = null;
let _configMetadata = null;

function getEnumOptions() {
  return _configMetadata?.settingsUi?.enumOptions || {};
}

function getLanguagePrompts() {
  return _configMetadata?.settingsUi?.languagePrompts || {};
}

function getFolderBrowseKeys() {
  return _configMetadata?.settingsUi?.pathFieldKeys?.folder || [];
}

function getFileBrowseKeys() {
  return _configMetadata?.settingsUi?.pathFieldKeys?.file || [];
}

function inferFieldType(key, value) {
  if (getEnumOptions()[key]) return 'select';
  if (value === 'True' || value === 'False') return 'boolean';
  if (!isNaN(value) && value !== '') return 'number';
  return 'text';
}

function buildField(section, key, value) {
  const row = document.createElement('div');
  row.className = 'field-row';

  const label = document.createElement('label');
  label.textContent = key;
  label.title = key;
  row.appendChild(label);

  const controlWrap = document.createElement('div');
  controlWrap.className = 'field-control';

  const fieldType = inferFieldType(key, value);
  let input;

  if (fieldType === 'select') {
    input = document.createElement('select');
    const options = getEnumOptions()[key];
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (opt === value) o.selected = true;
      input.appendChild(o);
    }
    // Allow typing a custom value not in the list
    if (!options.includes(value)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = value;
      o.selected = true;
      input.insertBefore(o, input.firstChild);
    }
  } else if (fieldType === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value === 'True';
  } else if (fieldType === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    input.value = value;
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = value;
  }

  input.dataset.section = section;
  input.dataset.key = key;
  controlWrap.appendChild(input);

  // Browse button for path fields
  if (getFolderBrowseKeys().includes(key)) {
    const btn = document.createElement('button');
    btn.className = 'btn-field-browse';
    btn.textContent = '…';
    btn.title = 'Browse folder';
    btn.addEventListener('click', async () => {
      const folder = await window.electronAPI.browseFolder();
      if (folder) input.value = folder;
    });
    controlWrap.appendChild(btn);
  } else if (getFileBrowseKeys().includes(key)) {
    const btn = document.createElement('button');
    btn.className = 'btn-field-browse';
    btn.textContent = '…';
    btn.title = 'Browse file';
    btn.addEventListener('click', async () => {
      const file = await window.electronAPI.browseFile();
      if (file) input.value = file;
    });
    controlWrap.appendChild(btn);
  }

  row.appendChild(controlWrap);
  return row;
}

function collectFormValues() {
  const result = {};
  const inputs = document.querySelectorAll('#settings-content [data-section][data-key]');
  for (const el of inputs) {
    const { section, key } = el.dataset;
    if (!result[section]) result[section] = {};
    if (el.type === 'checkbox') {
      result[section][key] = el.checked ? 'True' : 'False';
    } else {
      result[section][key] = el.value;
    }
  }
  return result;
}

async function renderSettings() {
  const container = document.getElementById('settings-content');
  container.innerHTML = '<p class="loading-msg">Loading config...</p>';

  try {
    _configMetadata = await window.electronAPI.readConfigMetadata();
    _configObj = await window.electronAPI.readConfig();
  } catch (e) {
    container.innerHTML = `<p class="error-msg">Failed to load config: ${e.message}</p>`;
    return;
  }

  container.innerHTML = '';

  for (const [section, fields] of Object.entries(_configObj).filter(([s]) => s !== 'WEBUI_SETTING')) {
    const isCollapsed = localStorage.getItem(`section-collapsed:${section}`) === 'true';

    const header = document.createElement('div');
    header.className = 'section-header section-header-collapsible';
    header.innerHTML = `<span>[${section}]</span><svg class="section-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;
    if (isCollapsed) header.classList.add('collapsed');
    container.appendChild(header);

    const group = document.createElement('div');
    group.className = 'section-group';
    if (isCollapsed) group.hidden = true;
    for (const [key, value] of Object.entries(fields)) {
      group.appendChild(buildField(section, key, String(value)));
    }
    container.appendChild(group);

    header.addEventListener('click', () => {
      const collapsed = !group.hidden;
      group.hidden = collapsed;
      header.classList.toggle('collapsed', collapsed);
      localStorage.setItem(`section-collapsed:${section}`, collapsed);
    });
  }

  initLanguagePromptSync();
  initDirtyTracking();
}

function initDirtyTracking() {
  const inputs = document.querySelectorAll('#settings-content [data-section][data-key]');
  inputs.forEach(el => {
    el.addEventListener('input', markDirty);
    el.addEventListener('change', markDirty);
  });
}

function markDirty() {
  _saveBtn.classList.add('dirty');
}

function clearDirty() {
  _saveBtn.classList.remove('dirty');
}

function initLanguagePromptSync() {
  const langSelect  = document.querySelector('[data-section="SETTING"][data-key="language"]');
  const promptInput = document.querySelector('[data-section="SETTING"][data-key="initial_prompt"]');
  if (!langSelect || !promptInput) return;
  langSelect.addEventListener('change', () => {
    const preset = getLanguagePrompts()[langSelect.value];
    if (preset !== undefined) promptInput.value = preset;
  });
}

async function saveSettings() {
  const data = collectFormValues();
  await window.electronAPI.writeConfig(data);
  _configObj = data;
  clearDirty();
}

// Save button
const _saveBtn = document.getElementById('btn-save-settings');
_saveBtn.addEventListener('click', async () => {
  await saveSettings();
  const orig = _saveBtn.textContent;
  _saveBtn.textContent = 'Saved ✓';
  _saveBtn.disabled = true;
  showToast('設定已儲存', 'success', 2000);
  setTimeout(() => { _saveBtn.textContent = orig; _saveBtn.disabled = false; }, 1800);
});

export { renderSettings, saveSettings, collectFormValues };
