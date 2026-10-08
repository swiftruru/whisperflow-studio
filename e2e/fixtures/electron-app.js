'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { test: base, _electron: electron } = require('@playwright/test');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_SETTINGS = path.join(__dirname, 'test-settings.json');
const CONFIG_TEMPLATE = path.join(PROJECT_ROOT, 'python', 'config', 'config.example.json');
const PROJECT_CONFIG = path.join(PROJECT_ROOT, 'python', 'config', 'config.json');

/**
 * Per-test Electron fixture.
 *
 * - Creates an isolated userData dir under the OS temp folder so the test
 *   never touches the developer's real settings.json / history / cache.
 * - Pre-writes settings.json with `uiLanguage: 'en'` and
 *   `hasSeenOnboarding: true` so assertions don't depend on system locale
 *   and the onboarding tour doesn't pop and obscure the UI.
 * - Gives the run its own `python/config` equivalent, seeded from
 *   config.example.json, with a media root and models dir that exist inside
 *   the temp tree.  Without this the suite reads -- and CREATES -- the
 *   developer's own python/config/config.json: `readConfig` seeds the file
 *   when it is missing and `ensureModelsDirInConfig` then writes this
 *   fixture's throwaway userData path into `models_dir`, which teardown
 *   deletes.  It also made the status-badge assertion depend on whatever
 *   `media_root_path` happened to be set to on the machine.
 * - Sets WHISPERFLOW_E2E=1 so main.js skips the auto-updater and tray.
 * - Yields the launched ElectronApplication, its first window, and the temp
 *   paths so a spec can assert against them.
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

    // Isolated stand-in for <project>/python/config.  Only the writable half
    // moves: config.metadata.json is tracked and read-only, so the app keeps
    // reading it from its own tree.
    const configDir = path.join(userDataDir, 'python-config');
    const mediaRootDir = path.join(userDataDir, 'media');
    for (const dir of [configDir, mediaRootDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Seed from the tracked template so the fixture inherits real defaults
    // and does not drift as keys are added.  media_root_path must point at a
    // directory that EXISTS: preflight treats both unset and missing as a
    // blocking error, which is what makes the badge read "Setup".
    // `models_dir` is left at the template's empty string ON PURPOSE: that is
    // the fresh-clone condition, and it makes `ensureModelsDirInConfig` take
    // its write path during the launch.  That write is what used to land in
    // the project tree, so letting it happen here is the test.
    const seed = JSON.parse(fs.readFileSync(CONFIG_TEMPLATE, 'utf-8'));
    seed.SETTING = {
      ...seed.SETTING,
      media_root_path: mediaRootDir,
      media_file_path: mediaRootDir,
    };
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      `${JSON.stringify(seed, null, 2)}\n`,
      'utf-8',
    );

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
        WHISPERFLOW_E2E_CONFIG_DIR: configDir,
      },
      timeout: 30_000,
    });

    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    // Renderer wires DOM listeners after i18n init — give it a beat so
    // tab clicks etc. land on a wired-up DOM.
    await window.waitForSelector('#tab-main.active', { timeout: 10_000 });

    await use({
      electronApp,
      window,
      userDataDir,
      configDir,
      mediaRootDir,
      projectConfigPath: PROJECT_CONFIG,
    });

    await electronApp.close().catch(() => { /* already exited */ });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },
});

module.exports = { test, expect: base.expect };
