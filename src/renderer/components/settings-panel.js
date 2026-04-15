'use strict';

import { showToast } from './toast.js';
import { refreshPreflight } from './preflight-panel.js';
import { VENV_INITIALIZED_EVENT } from '../lib/venv-bootstrap.js';

const APP_SETTINGS_SECTION = 'APP_SETTINGS';
const VALIDATED_FIELD_KEYS = new Set([
  'pythonPath',
  'media_root_path',
]);

const validationTimers = new WeakMap();

let configObj = null;
let appSettingsObj = null;
let configMetadata = null;

// Per-model dynamic-enum overrides.  The ``model`` field's dropdown used to
// come from a static list in config.metadata.json; now it's populated at
// render time from the Model Manager IPC so users only see models they've
// actually downloaded (plus any custom entries already in their config).
let dynamicModelNames = null;

async function loadDynamicModelNames() {
  // Keep retrying until we actually get a populated list — the venv may not
  // be initialised on first call, in which case we want the next render to
  // try again rather than getting stuck on an empty cache.
  if (Array.isArray(dynamicModelNames) && dynamicModelNames.length > 0) {
    return dynamicModelNames;
  }
  try {
    const result = await window.electronAPI.listModels();
    const list = Array.isArray(result?.models) ? result.models : [];
    dynamicModelNames = list.map((entry) => entry.name);
  } catch (_) {
    dynamicModelNames = null;
  }
  return dynamicModelNames;
}

function invalidateDynamicModelNames() {
  dynamicModelNames = null;
}

function getEnumOptions(key) {
  const base = configMetadata?.settingsUi?.enumOptions || {};
  if (key === 'model' && Array.isArray(dynamicModelNames) && dynamicModelNames.length > 0) {
    return { ...base, model: dynamicModelNames };
  }
  return base;
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
  if (getEnumOptions(key)[key]) return 'select';
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
    const options = getEnumOptions(key)[key];
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
      const file = key === 'pythonPath'
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
      // If this field's value was auto-filled by the validator (the user
      // never typed it), persist it as an empty string instead of the
      // resolved absolute path.  Otherwise moving the project would break
      // because the saved path would point at the old location.
      const isAutoResolvedPath =
        key === 'pythonPath'
        && el.dataset.autoResolved === 'true'
        && el.value.trim() === (el.dataset.autoResolvedValue || '').trim();

      result[section][key] = isAutoResolvedPath ? '' : el.value;
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
      pythonPath: nextAppSettings.pythonPath?.trim() ? nextAppSettings.pythonPath.trim() : null,
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

function syncResolvedDisplayValue(input, result) {
  if (input.dataset.key !== 'pythonPath' || input.type !== 'text') return;

  const currentValue = input.value.trim();
  if (currentValue) {
    input.title = currentValue;
    if (input.dataset.autoResolved === 'true' && currentValue !== (input.dataset.autoResolvedValue || '')) {
      input.dataset.autoResolved = 'false';
    }
    return;
  }

  if (result?.status === 'ok' && result.detail) {
    input.value = result.detail;
    input.dataset.autoResolved = 'true';
    input.dataset.autoResolvedValue = result.detail;
    input.title = result.detail;
    return;
  }

  input.dataset.autoResolved = 'false';
  input.dataset.autoResolvedValue = '';
  input.title = '';
}

function applyValidationState(input, result) {
  const hint = getValidationHint(input);
  syncResolvedDisplayValue(input, result);
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
      input.addEventListener('input', () => {
        if (input.dataset.key === 'pythonPath' && input.dataset.autoResolved === 'true') {
          input.dataset.autoResolved = 'false';
        }
        scheduleValidation(input);
      });
      input.addEventListener('blur', () => validateFieldElement(input));
      input.addEventListener('change', () => {
        if (input.dataset.key === 'pythonPath' && input.dataset.autoResolved === 'true') {
          input.dataset.autoResolved = 'false';
        }
        validateFieldElement(input);
      });
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
    await loadDynamicModelNames();
  } catch (error) {
    container.innerHTML = `<p class="error-msg">Failed to load config: ${error.message}</p>`;
    return;
  }

  // Sanity check: if the SETTING section is missing or empty here, future
  // saves will silently rewrite an empty form into config.json (Bug A from
  // 2026-04-15).  Surface it loudly in the console so the next regression
  // is easy to spot.
  if (!configObj || !configObj.SETTING || Object.keys(configObj.SETTING).length === 0) {
    console.warn('[WhisperFlow Studio] settings-panel rendered with empty SETTING section', { configObj });
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

// Called when the venv finishes bootstrapping from any tab. Refreshes the
// model dropdown options (now that listModels actually works) and pulls in
// the auto-injected `models_dir` value from the Electron main process —
// without re-rendering the whole form, so any unsaved field edits are
// preserved.
async function refreshAfterVenvInit() {
  // 1. Re-fetch the dynamic model list now that the venv is alive.
  invalidateDynamicModelNames();
  await loadDynamicModelNames();

  // 2. Rebuild the `model` <select>'s options in place, preserving the
  //    current selection so the user doesn't lose context.
  const modelSelect = document.querySelector('#settings-content [data-section="SETTING"][data-key="model"]');
  if (modelSelect && modelSelect.tagName === 'SELECT') {
    const previousValue = modelSelect.value;
    const options = getEnumOptions('model').model || [];
    modelSelect.innerHTML = '';
    for (const opt of options) {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      if (opt === previousValue) option.selected = true;
      modelSelect.appendChild(option);
    }
    // Preserve a custom value the user may have typed/saved earlier.
    if (previousValue && !options.includes(previousValue)) {
      const option = document.createElement('option');
      option.value = previousValue;
      option.textContent = previousValue;
      option.selected = true;
      modelSelect.insertBefore(option, modelSelect.firstChild);
    }
  }

  // 3. Pull in models_dir from config.json if the field is currently empty.
  //    Main process auto-injects models_dir when venv:initialize starts; we
  //    only overwrite empty inputs so the user doesn't lose any value they
  //    were in the middle of editing.
  try {
    const fresh = await window.electronAPI.readConfig();
    const freshModelsDir = fresh?.SETTING?.models_dir || '';
    if (freshModelsDir) {
      // Update the in-memory mirror so collectFormValues() picks it up too.
      if (configObj?.SETTING) {
        configObj.SETTING.models_dir = freshModelsDir;
      }
      const modelsDirInput = document.querySelector('#settings-content [data-section="SETTING"][data-key="models_dir"]');
      if (modelsDirInput && !modelsDirInput.value.trim()) {
        modelsDirInput.value = freshModelsDir;
        modelsDirInput.title = freshModelsDir;
      }
    }
  } catch (_) {
    // Non-fatal — leave the form alone if config:read fails.
  }
}

async function saveSettings() {
  const data = collectFormValues();
  const { configData, appSettings } = splitFormValues(data);

  // CRITICAL: don't replace the on-disk config wholesale.  If the form
  // didn't render a particular section for any reason (collapsed state,
  // partial render, future refactor), `configData` won't contain that
  // section and a naive write would drop it on the floor — which is how
  // we used to wipe `media_root_path` and friends.  Instead, deep-merge
  // form values INTO whatever's on disk right now.
  let mergedConfig;
  try {
    const onDisk = await window.electronAPI.readConfig();
    mergedConfig = deepMergeConfig(onDisk || {}, configData);
  } catch (_) {
    mergedConfig = configData;
  }

  await Promise.all([
    window.electronAPI.writeConfig(mergedConfig),
    window.electronAPI.writeAppSettings(appSettings),
  ]);

  configObj = mergedConfig;
  appSettingsObj = appSettings;
  clearDirty();
  await refreshPreflight();
}

function deepMergeConfig(base, overrides) {
  const result = { ...(base || {}) };
  for (const [section, value] of Object.entries(overrides || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[section] = { ...(result[section] || {}), ...value };
    } else {
      result[section] = value;
    }
  }
  return result;
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

// Refresh the model dropdown + models_dir input after the venv finishes
// bootstrapping from any tab.
window.addEventListener(VENV_INITIALIZED_EVENT, () => {
  refreshAfterVenvInit().catch((error) => {
    console.error('[WhisperFlow Studio] Failed to refresh settings after venv init:', error);
  });
});

export {
  collectFormValues,
  invalidateDynamicModelNames,
  renderSettings,
  saveSettings,
};
