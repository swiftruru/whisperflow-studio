'use strict';

import { showToast } from './toast.js';
import { t } from '../lib/i18n.js';
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
  row.dataset.key = key;

  const fieldType = inferFieldType(key, value);
  if (fieldType === 'boolean') row.classList.add('field-row-bool');

  // Left-hand label block: human-friendly label + description.  We look
  // up an explicit label via i18n first (settings:fields.<key>.label),
  // fall back to a humanized version of the key name (snake_case →
  // "Snake case") so the UI never exposes raw identifier strings.
  const labelBlock = document.createElement('div');
  labelBlock.className = 'field-label-block';

  const humanLabel = t(`settings:fields.${key}.label`, {
    defaultValue: humanizeKey(key),
  });
  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = humanLabel;
  // Tooltip shows the raw config.json key for power users who want
  // to trace "which JSON key am I editing?" — keeps the row tidy.
  label.title = key;
  labelBlock.appendChild(label);

  const descriptionText = t(`settings:fields.${key}.description`, { defaultValue: '' });
  if (descriptionText) {
    const descEl = document.createElement('div');
    descEl.className = 'field-description';
    descEl.textContent = descriptionText;
    labelBlock.appendChild(descEl);
  }

  row.appendChild(labelBlock);

  const controlWrap = document.createElement('div');
  controlWrap.className = 'field-control';

  const inputRow = document.createElement('div');
  inputRow.className = 'field-input-row';

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

  // pythonPath gets an extra "Detect now" button that re-runs the
  // resolver from scratch.  Useful when the user installed Python AFTER
  // the app booted (first-launch auto-detect missed it) and wants to
  // re-discover without restarting the whole app.  We clear whatever's
  // in the field first so `resolveSystemPython` walks the full detection
  // chain (known paths → pyenv-win → self-report → PATH); if it still
  // fails the field ends up empty + field-hint shows the error message.
  if (key === 'pythonPath') {
    const detectBtn = document.createElement('button');
    detectBtn.className = 'btn-field-detect';
    detectBtn.type = 'button';
    const detectLabel = t('settings:fields.pythonPath.detectButton') || 'Detect';
    detectBtn.textContent = detectLabel;
    detectBtn.title = detectLabel;
    detectBtn.addEventListener('click', async () => {
      const originalLabel = detectBtn.textContent;
      detectBtn.disabled = true;
      detectBtn.textContent = t('settings:fields.pythonPath.detecting');
      // Clear so the validator runs an unconstrained lookup; mark as
      // not-auto-resolved so a subsequent failure doesn't leave a
      // stale path in the field.
      input.value = '';
      input.dataset.autoResolved = 'false';
      input.dataset.autoResolvedValue = '';
      try {
        await validateFieldElement(input);
        // Main-tab preflight's "找不到 Python 3" banner uses the same
        // resolver, so refresh it now — otherwise the user sees a
        // successful detect here but a stale error on the Main tab.
        await refreshPreflight();

        if (input.value && input.value.trim()) {
          showToast(
            t('settings:fields.pythonPath.detectSuccess', { path: input.value.trim() }),
            'success',
            3000,
          );
        } else {
          showToast(t('settings:fields.pythonPath.detectFailed'), 'error', 4000);
        }
      } finally {
        detectBtn.disabled = false;
        detectBtn.textContent = originalLabel;
      }
    });
    inputRow.appendChild(detectBtn);
  }

  const hint = document.createElement('div');
  hint.className = 'field-hint';
  hint.hidden = true;

  controlWrap.appendChild(inputRow);
  controlWrap.appendChild(hint);

  row.appendChild(controlWrap);
  return row;
}

function humanizeKey(key) {
  if (!key) return '';
  // pythonPath → "Python path", max_line_width → "Max line width"
  const withSpaces = String(key)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ');
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
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

  // Re-inject any app-setting keys that exist on disk but were
  // deliberately hidden from the form (e.g. uiLanguage, which is
  // owned by the titlebar toggle).  Without this the form save would
  // silently delete those keys every time the user clicks Save.
  const preserved = {};
  for (const hiddenKey of HIDDEN_APP_SETTING_KEYS) {
    if (appSettingsObj && hiddenKey in appSettingsObj) {
      preserved[hiddenKey] = appSettingsObj[hiddenKey];
    }
  }

  return {
    configData: nextConfig,
    appSettings: {
      ...preserved,
      ...nextAppSettings,
      pythonPath: nextAppSettings.pythonPath?.trim() ? nextAppSettings.pythonPath.trim() : null,
    },
  };
}

// Keys that exist in settings.json but are NOT rendered as form fields.
// `uiLanguage` is set from the titlebar toggle and the Settings form
// would just duplicate that control, so we hide it here while still
// preserving the value on disk via the save-side merge below.
const HIDDEN_APP_SETTING_KEYS = new Set([
  'uiLanguage',       // owned by the titlebar language toggle
  'hasSeenOnboarding', // internal onboarding-tour flag, not user-editable
  'updater',           // nested object owned by the updater module
]);

function getHiddenFieldKeys() {
  const list = configMetadata?.settingsUi?.hiddenFieldKeys;
  return new Set(Array.isArray(list) ? list : []);
}

function getFieldGroups() {
  const groups = configMetadata?.settingsUi?.fieldGroups;
  return Array.isArray(groups) ? groups : [];
}

/**
 * Build a flat lookup of every visible field: key → { section, value }.
 * APP_SETTINGS and SETTING are collapsed into one map so fieldGroups
 * metadata can reference any key without caring about which section it
 * lives in.  HIDDEN_APP_SETTING_KEYS and hiddenFieldKeys are filtered
 * out here so consumers never see internal-state fields.
 */
function buildFieldLookup() {
  const hiddenConfigKeys = getHiddenFieldKeys();
  const lookup = {};
  for (const [k, v] of Object.entries(appSettingsObj || {})) {
    if (HIDDEN_APP_SETTING_KEYS.has(k)) continue;
    lookup[k] = { section: APP_SETTINGS_SECTION, value: v };
  }
  for (const [section, fields] of Object.entries(configObj || {})) {
    if (!fields || typeof fields !== 'object') continue;
    for (const [k, v] of Object.entries(fields)) {
      if (hiddenConfigKeys.has(k)) continue;
      lookup[k] = { section, value: v };
    }
  }
  return lookup;
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
  container.innerHTML = `<p class="loading-msg">${t('settings:loading')}</p>`;

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

  const lookup = buildFieldLookup();
  const groups = getFieldGroups();
  const claimed = new Set();

  for (const group of groups) {
    const keys = (group.keys || []).filter((k) => lookup[k] !== undefined);
    if (keys.length === 0) continue;
    container.appendChild(buildGroupCard({ group, keys, lookup }));
    keys.forEach((k) => claimed.add(k));
  }

  // Any field not explicitly grouped lands in an "Other" card at the
  // end — ensures a schema extension (e.g. someone adds a new config
  // key without updating fieldGroups) still renders a control instead
  // of silently dropping the field.
  const unclaimed = Object.keys(lookup).filter((k) => !claimed.has(k));
  if (unclaimed.length > 0) {
    container.appendChild(buildGroupCard({
      group: { id: 'other' },
      keys: unclaimed,
      lookup,
    }));
  }

  initLanguagePromptSync();
  initDirtyTracking();
  initFieldValidation();
}

function buildGroupCard({ group, keys, lookup }) {
  const card = document.createElement('section');
  card.className = 'settings-group-card';
  card.dataset.group = group.id;
  // Tag the card with its segment (transcription / app) so the top
  // segmented control can hide/show entire cards without re-rendering.
  if (group.segment) card.dataset.segment = group.segment;

  const storedCollapsed = localStorage.getItem(`settings-group-collapsed:${group.id}`);
  const isCollapsed = storedCollapsed === 'true'
    || (storedCollapsed === null && group.defaultCollapsed === true);

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'settings-group-header';
  if (isCollapsed) header.classList.add('collapsed');

  const headerText = document.createElement('div');
  headerText.className = 'settings-group-header-text';
  const title = document.createElement('div');
  title.className = 'settings-group-title';
  title.textContent = t(`settings:groups.${group.id}.title`, { defaultValue: group.id });
  headerText.appendChild(title);

  const desc = t(`settings:groups.${group.id}.description`, { defaultValue: '' });
  if (desc) {
    const descEl = document.createElement('div');
    descEl.className = 'settings-group-description';
    descEl.textContent = desc;
    headerText.appendChild(descEl);
  }

  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('class', 'settings-group-chevron');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('width', '14');
  chevron.setAttribute('height', '14');
  chevron.setAttribute('fill', 'none');
  chevron.setAttribute('stroke', 'currentColor');
  chevron.setAttribute('stroke-width', '2.5');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '6 9 12 15 18 9');
  chevron.appendChild(polyline);

  header.appendChild(headerText);
  header.appendChild(chevron);

  const body = document.createElement('div');
  body.className = 'settings-group-body';
  if (isCollapsed) body.hidden = true;

  for (const key of keys) {
    const { section, value } = lookup[key];
    body.appendChild(buildField(section, key, toDisplayValue(value)));
  }

  header.addEventListener('click', () => {
    const collapsed = !body.hidden;
    body.hidden = collapsed;
    header.classList.toggle('collapsed', collapsed);
    localStorage.setItem(`settings-group-collapsed:${group.id}`, String(collapsed));
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
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

  // NOTE: uiLanguage no longer lives in this form — the titlebar
  // language toggle owns it and pushes through i18n:set-language
  // directly.  splitFormValues() re-injects the current value from
  // `appSettingsObj` so writeAppSettings doesn't drop the key; no
  // post-save language flip is needed here.

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
  saveBtn.textContent = t('settings:toolbar.saved');
  saveBtn.disabled = true;
  showToast(t('settings:toast.saved'), 'success', 2000);
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

// Re-render the whole settings form on language switch so all the
// field-description strings pick up the new locale.  renderSettings()
// is idempotent and already handles re-reading config, so we just
// call it — cheaper than surgically patching every description node.
window.addEventListener('app:language-changed', () => {
  // Only re-render if the form is already populated; pre-init switches
  // are handled by the initial render.
  if (document.getElementById('settings-content')?.children.length > 0) {
    renderSettings().catch((error) => {
      console.error('[WhisperFlow Studio] Failed to re-render settings on language change:', error);
    });
  }
});

// ── Segmented control (Transcription / App) ─────────────────────────────
// Each group card gets a `data-segment` attribute during render, and the
// hand-written local-prefs cards (shortcuts / a11y) are tagged in HTML.
// We toggle visibility with a single class on #tab-settings so the CSS
// owns all the show/hide logic — no per-card display juggling here.
const ACTIVE_SEGMENT_KEY = 'settings.activeSegment';
const DEFAULT_SEGMENT = 'transcription';

function getStoredSegment() {
  try {
    const v = localStorage.getItem(ACTIVE_SEGMENT_KEY);
    if (v === 'transcription' || v === 'app') return v;
  } catch (_) {}
  return DEFAULT_SEGMENT;
}

function applySettingsSegment(segment) {
  const tab = document.getElementById('tab-settings');
  if (!tab) return;
  const resolved = (segment === 'app' || segment === 'transcription') ? segment : DEFAULT_SEGMENT;
  tab.dataset.activeSegment = resolved;
  const buttons = document.querySelectorAll('#settings-segments .settings-segment');
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.segment === resolved);
    btn.setAttribute('aria-selected', btn.dataset.segment === resolved ? 'true' : 'false');
  });
  try { localStorage.setItem(ACTIVE_SEGMENT_KEY, resolved); } catch (_) {}
}

function initSettingsSegments() {
  const container = document.getElementById('settings-segments');
  if (!container) return;
  container.querySelectorAll('.settings-segment').forEach((btn) => {
    btn.addEventListener('click', () => applySettingsSegment(btn.dataset.segment));
  });
  applySettingsSegment(getStoredSegment());
}

export {
  collectFormValues,
  invalidateDynamicModelNames,
  renderSettings,
  saveSettings,
  initSettingsSegments,
  applySettingsSegment,
};
