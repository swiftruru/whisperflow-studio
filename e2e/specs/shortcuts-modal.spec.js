'use strict';

const { test, expect } = require('../fixtures/electron-app');

test.describe('shortcuts modal — keyboard help', () => {
  test('? opens the modal, Esc closes it', async ({ app }) => {
    const { window } = app;
    const modal = window.locator('#shortcuts-modal');

    // Hidden on boot.
    await expect(modal).toBeHidden();

    // Dispatch the keydown directly on document so we don't have to fight
    // with focus/IME/keyboard layout differences. The renderer's global
    // listener checks `e.key === '?'` and the active element's tagName
    // — body is fine, no INPUT focused.
    await window.evaluate(() => {
      document.body.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    });
    await expect(modal).toBeVisible();

    await window.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(modal).toBeHidden();
  });
});
