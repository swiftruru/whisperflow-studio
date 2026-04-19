'use strict';

const { test, expect } = require('../fixtures/electron-app');

test.describe('i18n — language toggle', () => {
  test('clicking 中/EN swaps tab labels between English and 繁體中文', async ({ app }) => {
    const { window } = app;
    const mainTab = window.locator('.tab-btn[data-tab="main"]');

    // Fixture pins uiLanguage to 'en' on boot.
    await expect(mainTab).toHaveText('Main');

    await window.locator('#btn-language-toggle').click();
    await expect(mainTab).toHaveText('主要');

    // And back, to prove the toggle is symmetric, not one-way.
    await window.locator('#btn-language-toggle').click();
    await expect(mainTab).toHaveText('Main');
  });
});
