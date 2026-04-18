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

function initA11yControls() {
  const fontSelect = document.getElementById('a11y-font-size');
  const hcToggle = document.getElementById('a11y-high-contrast');
  if (fontSelect) {
    fontSelect.value = getFontSize();
    fontSelect.addEventListener('change', () => setFontSize(fontSelect.value));
  }
  if (hcToggle) {
    hcToggle.checked = getHighContrast();
    hcToggle.addEventListener('change', () => setHighContrast(hcToggle.checked));
  }
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
