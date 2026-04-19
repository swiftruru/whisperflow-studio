'use strict';

const { test, expect } = require('../fixtures/electron-app');

test.describe('theme — light/dark toggle', () => {
  test('clicking the theme button flips <html data-theme> and swaps icons', async ({ app }) => {
    const { window } = app;
    const html = window.locator('html');

    // First-launch default (no localStorage entry) is light mode:
    // <html data-theme="light">.
    await expect(html).toHaveAttribute('data-theme', 'light');

    // Click → dark mode (data-theme attribute is removed entirely).
    await window.locator('#btn-theme-toggle').click();
    await expect(html).not.toHaveAttribute('data-theme', /.+/);

    // Click again → back to light.
    await window.locator('#btn-theme-toggle').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
  });
});
