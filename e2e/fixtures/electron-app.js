'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { test: base, _electron: electron } = require('@playwright/test');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_SETTINGS = path.join(__dirname, 'test-settings.json');

/**
 * Per-test Electron fixture.
 *
 * - Creates an isolated userData dir under the OS temp folder so the test
 *   never touches the developer's real settings.json / history / cache.
 * - Pre-writes settings.json with `uiLanguage: 'en'` and
 *   `hasSeenOnboarding: true` so assertions don't depend on system locale
 *   and the onboarding tour doesn't pop and obscure the UI.
 * - Sets WHISPERFLOW_E2E=1 so main.js skips the auto-updater and tray.
 * - Yields the launched ElectronApplication and its first window.
 * - Tears down the app and the temp dir afterwards.
 */
const test = base.extend({
  app: async ({}, use, testInfo) => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `wfs-e2e-${testInfo.project.name}-`),
    );

    // Seed an isolated settings.json that locks the language and skips
    // first-run flows. Writing to userData (not project root) means the
    // packaged-vs-dev path branch in main.js is irrelevant — we override
    // userData below via WHISPERFLOW_E2E_USERDATA, so this file lives
    // exactly where main.js will look.
    fs.copyFileSync(TEMPLATE_SETTINGS, path.join(userDataDir, 'settings.json'));

    const electronApp = await electron.launch({
      args: ['.'],
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        // Same hygiene the npm start script uses: clear inherited
        // ELECTRON_RUN_AS_NODE so electron launches as a GUI process.
        ELECTRON_RUN_AS_NODE: '',
        WHISPERFLOW_E2E: '1',
        WHISPERFLOW_E2E_USERDATA: userDataDir,
      },
      timeout: 30_000,
    });

    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    // Renderer wires DOM listeners after i18n init — give it a beat so
    // tab clicks etc. land on a wired-up DOM.
    await window.waitForSelector('#tab-main.active', { timeout: 10_000 });

    await use({ electronApp, window, userDataDir });

    await electronApp.close().catch(() => { /* already exited */ });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },
});

module.exports = { test, expect: base.expect };
