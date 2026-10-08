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

    // Status badge resolves to the English "Idle" since the fixture pins en
    // AND gives the run its own config whose media root exists.  It reads
    // "Setup" whenever preflight has a blocking check, so on failure name the
    // checks rather than leaving a bare Idle/Setup diff: everything that can
    // still block here is the developer's toolchain (venv, whisperflow
    // package, ffmpeg), not their config file.
    const badge = window.locator('#status-badge');
    if ((await badge.textContent())?.trim() !== 'Idle') {
      const blocking = await window.evaluate(async () => {
        const result = await window.electronAPI.runPreflight();
        return (result?.blockingChecks || []).map((c) => `${c.key}: ${c.code}`);
      });
      expect(blocking, 'preflight reported blocking checks').toEqual([]);
    }
    await expect(badge).toHaveText('Idle');
  });
});
