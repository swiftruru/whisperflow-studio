'use strict';

const { test, expect } = require('../fixtures/electron-app');

test.describe('smoke — app boots and renders', () => {
  test('main window opens with WhisperFlow Studio title and Main tab active', async ({ app }) => {
    const { window } = app;

    // The window's <title> is set in index.html to "WhisperFlow Studio".
    await expect(window).toHaveTitle(/WhisperFlow Studio/);

    // Titlebar brand is visible.
    await expect(window.locator('.titlebar-title')).toHaveText('WhisperFlow Studio');

    // Main tab starts active and the corresponding pane is shown.
    await expect(window.locator('.tab-btn[data-tab="main"]')).toHaveClass(/active/);
    await expect(window.locator('#tab-main')).toBeVisible();

    // Status badge resolves to the English "Idle" since fixture pins en.
    await expect(window.locator('#status-badge')).toHaveText('Idle');
  });
});
