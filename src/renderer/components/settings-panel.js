'use strict';

import { showToast } from './toast.js';
import { refreshPreflight } from './preflight-panel.js';

const APP_SETTINGS_SECTION = 'APP_SETTINGS';
const VALIDATED_FIELD_KEYS = new Set([
  'poetryPath',
  'whisper_faster_tool_path',
  'media_root_path',
]);

const validationTimers = new WeakMap();

let configObj = null;
let appSettingsObj = null;
let configMetadata = null;

function getEnumOptions() {
  return configMetadata?.settingsUi?.enumOptions || {};
}

function getLanguagePrompts() {
  return configMetadata?.settingsUi?.languagePrompts || {};
}

function getFolderBrowseKeys() {
  return configMetadata?.settingsUi?.pathFieldKeys?.folder || [];
}

function getFileBrowseKeys() {
  return configMetadata?.settingsUi?.pathFieldKeys?.file || [];
}

function inferFieldType(key, value) {
  if (getEnumOptions()[key]) return 'select';
  if (value === 'True' || value === 'False') return 'boolean';
  if (!isNaN(value) && value !== '') return 'number';
  return 'text';
}

function toDisplayValue(value) {
  return value === null || value === undefined ? '' : String(value);
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

  const inputRow = document.createElement('div');
  inputRow.className = 'field-input-row';

  const fieldType = inferFieldType(key, value);
  let input;

  if (fieldType === 'select') {
    input = document.createElement('select');
    const options = getEnumOptions()[key];
    for (const opt of options) {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      if (opt === value) option.selected = true;
      input.appendChild(option);
    }

    if (!options.includes(value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      option.selected = true;
      input.insertBefore(option, input.firstChild);
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
  inputRow.appendChild(input);

  if (getFolderBrowseKeys().includes(key)) {
    const btn = document.createElement('button');
    btn.className = 'btn-field-browse';
    btn.textContent = '…';
    btn.title = 'Browse folder';
    btn.addEventListener('click', async () => {
      const folder = await window.electronAPI.browseFolder();
      if (folder) {
        input.value = folder;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    inputRow.appendChild(btn);
  } else if (getFileBrowseKeys().includes(key)) {
    const btn = document.createElement('button');
    btn.className = 'btn-field-browse';
    btn.textContent = '…';
    btn.title = 'Browse file';
    btn.addEventListener('click', async () => {
      const file = key === 'poetryPath'
        ? await window.electronAPI.browseAnyFile()
        : await window.electronAPI.browseFile();
      if (file) {
        input.value = file;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    inputRow.appendChild(btn);
  }

  const hint = document.createElement('div');
  hint.className = 'field-hint';
  hint.hidden = true;

  controlWrap.appendChild(inputRow);
  controlWrap.appendChild(hint);
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

function splitFormValues(data) {
  const nextConfig = { ...(data || {}) };
  const nextAppSettings = { ...(nextConfig[APP_SETTINGS_SECTION] || {}) };
  delete nextConfig[APP_SETTINGS_SECTION];

  return {
    configData: nextConfig,
    appSettings: {
      ...nextAppSettings,
      poetryPath: nextAppSettings.poetryPath?.trim() ? nextAppSettings.poetryPath.trim() : null,
    },
  };
}

function getRenderedSections() {
  return [
    [APP_SETTINGS_SECTION, appSettingsObj || {}],
    ...Object.entries(configObj || {}),
  ];
}

function shouldValidateField(key) {
  return VALIDATED_FIELD_KEYS.has(key);
}

function getValidationHint(input) {
  return input.closest('.field-control')?.querySelector('.field-hint');
}

function applyValidationState(input, result) {
  const hint = getValidationHint(input);
  if (!hint) return;

  input.classList.remove('field-valid', 'field-invalid');
  hint.className = 'field-hint';

  if (!result || result.status === 'idle' || !result.message) {
    hint.hidden = true;
    hint.textContent = '';
    return;
  }

  hint.hidden = false;
  hint.textContent = result.message;
  hint.classList.add(result.status);

  if (result.status === 'error') {
    input.classList.add('field-invalid');
  } else if (result.status === 'ok') {
    input.classList.add('field-valid');
  }
}

async function validateFieldElement(input) {
  if (!shouldValidateField(input.dataset.key)) return;

  const value = input.type === 'checkbox'
    ? (input.checked ? 'True' : 'False')
    : input.value;

  const result = await window.electronAPI.validateSettingField({
    section: input.dataset.section,
    key: input.dataset.key,
    value,
  });

  applyValidationState(input, result);
}

function scheduleValidation(input) {
  clearTimeout(validationTimers.get(input));
  const timerId = setTimeout(() => {
    validateFieldElement(input);
  }, 220);
  validationTimers.set(input, timerId);
}

function initFieldValidation() {
  const inputs = document.querySelectorAll('#settings-content [data-section][data-key]');

  inputs.forEach((input) => {
    if (!shouldValidateField(input.dataset.key)) return;

    if (input.type === 'checkbox' || input.tagName === 'SELECT') {
      input.addEventListener('change', () => validateFieldElement(input));
    } else {
      input.addEventListener('input', () => scheduleValidation(input));
      input.addEventListener('blur', () => validateFieldElement(input));
      input.addEventListener('change', () => validateFieldElement(input));
    }

    validateFieldElement(input);
  });
}

async function renderSettings() {
  const container = document.getElementById('settings-content');
  container.innerHTML = '<p class="loading-msg">Loading config...</p>';

  try {
    [configMetadata, configObj, appSettingsObj] = await Promise.all([
      window.electronAPI.readConfigMetadata(),
      window.electronAPI.readConfig(),
      window.electronAPI.readAppSettings(),
    ]);
  } catch (error) {
    container.innerHTML = `<p class="error-msg">Failed to load config: ${error.message}</p>`;
    return;
  }

  container.innerHTML = '';

  for (const [section, fields] of getRenderedSections()) {
    const isCollapsed = localStorage.getItem(`section-collapsed:${section}`) === 'true';

    const header = document.createElement('div');
    header.className = 'section-header section-header-collapsible';
    header.innerHTML = `<span>[${section}]</span><svg class="section-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;
    if (isCollapsed) header.classList.add('collapsed');
    container.appendChild(header);

    const group = document.createElement('div');
    group.className = 'section-group';
    if (isCollapsed) group.hidden = true;

    for (const [key, rawValue] of Object.entries(fields)) {
      group.appendChild(buildField(section, key, toDisplayValue(rawValue)));
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
  initFieldValidation();
}

function initDirtyTracking() {
  const inputs = document.querySelectorAll('#settings-content [data-section][data-key]');
  inputs.forEach((el) => {
    el.addEventListener('input', markDirty);
    el.addEventListener('change', markDirty);
  });
}

function markDirty() {
  saveBtn.classList.add('dirty');
}

function clearDirty() {
  saveBtn.classList.remove('dirty');
}

function initLanguagePromptSync() {
  const langSelect = document.querySelector('[data-section="SETTING"][data-key="language"]');
  const promptInput = document.querySelector('[data-section="SETTING"][data-key="initial_prompt"]');
  if (!langSelect || !promptInput) return;

  langSelect.addEventListener('change', () => {
    const preset = getLanguagePrompts()[langSelect.value];
    if (preset !== undefined) promptInput.value = preset;
  });
}

async function saveSettings() {
  const data = collectFormValues();
  const { configData, appSettings } = splitFormValues(data);

  await Promise.all([
    window.electronAPI.writeConfig(configData),
    window.electronAPI.writeAppSettings(appSettings),
  ]);

  configObj = configData;
  appSettingsObj = appSettings;
  clearDirty();
  await refreshPreflight();
}

const saveBtn = document.getElementById('btn-save-settings');
saveBtn.addEventListener('click', async () => {
  await saveSettings();
  const original = saveBtn.textContent;
  saveBtn.textContent = 'Saved ✓';
  saveBtn.disabled = true;
  showToast('設定已儲存', 'success', 2000);
  setTimeout(() => {
    saveBtn.textContent = original;
    saveBtn.disabled = false;
  }, 1800);
});

export { collectFormValues, renderSettings, saveSettings };
