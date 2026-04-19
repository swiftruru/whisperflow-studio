'use strict';

/**
 * Accessibility helpers — font-size scale and high-contrast mode.
 *
 * Both preferences are stored in localStorage so they persist per
 * device and can be applied synchronously at boot (without an IPC
 * round-trip) to avoid a flash of the default style.  The boot
 * application lives in `theme-boot.js` next to the theme boot; this
 * file owns the runtime toggle UI bindings.
 */

import { createThemedSelect } from './themed-select.js';
import { t } from './i18n.js';

const FONT_SIZE_KEY = 'a11y.fontSize';
const HIGH_CONTRAST_KEY = 'a11y.highContrast';
const FONT_SIZE_VALUES = ['small', 'normal', 'large', 'xlarge'];
const DEFAULT_FONT_SIZE = 'normal';

function getFontSize() {
  try {
    const v = localStorage.getItem(FONT_SIZE_KEY);
    if (FONT_SIZE_VALUES.includes(v)) return v;
  } catch (_) {}
  return DEFAULT_FONT_SIZE;
}

function getHighContrast() {
  try {
    return localStorage.getItem(HIGH_CONTRAST_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function applyFontSize(size) {
  const value = FONT_SIZE_VALUES.includes(size) ? size : DEFAULT_FONT_SIZE;
  if (value === DEFAULT_FONT_SIZE) {
    document.documentElement.removeAttribute('data-font-size');
  } else {
    document.documentElement.setAttribute('data-font-size', value);
  }
}

function applyHighContrast(on) {
  if (on) {
    document.documentElement.setAttribute('data-high-contrast', 'true');
  } else {
    document.documentElement.removeAttribute('data-high-contrast');
  }
}

function setFontSize(size) {
  try { localStorage.setItem(FONT_SIZE_KEY, size); } catch (_) {}
  applyFontSize(size);
}

function setHighContrast(on) {
  try { localStorage.setItem(HIGH_CONTRAST_KEY, on ? '1' : '0'); } catch (_) {}
  applyHighContrast(on);
}

let _fontSizeWrapper = null;

function buildFontSizeOptions() {
  return FONT_SIZE_VALUES.map((v) => ({
    value: v,
    label: t(`settings:a11y.fontSize.${v}`),
  }));
}

function initA11yControls() {
  const mount = document.getElementById('a11y-font-size-mount');
  const hcToggle = document.getElementById('a11y-high-contrast');
  if (mount) {
    _fontSizeWrapper = createThemedSelect({
      options: buildFontSizeOptions(),
      value: getFontSize(),
      id: 'a11y-font-size',
      onChange: (v) => setFontSize(v),
    });
    mount.innerHTML = '';
    mount.appendChild(_fontSizeWrapper);
  }
  if (hcToggle) {
    hcToggle.checked = getHighContrast();
    hcToggle.addEventListener('change', () => setHighContrast(hcToggle.checked));
  }
  // Rebuild the font-size labels on locale change so the dropdown stays
  // localized without requiring a full reload.
  window.addEventListener('app:language-changed', () => {
    if (_fontSizeWrapper) {
      const current = _fontSizeWrapper.getValue();
      _fontSizeWrapper.setOptions(buildFontSizeOptions(), { preserveValue: true });
      _fontSizeWrapper.setValue(current);
    }
  });
  // Ensure attributes reflect stored values even on first render
  applyFontSize(getFontSize());
  applyHighContrast(getHighContrast());
}

export {
  FONT_SIZE_VALUES,
  getFontSize,
  getHighContrast,
  setFontSize,
  setHighContrast,
  applyFontSize,
  applyHighContrast,
  initA11yControls,
};
