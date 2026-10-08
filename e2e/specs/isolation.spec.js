'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('../fixtures/electron-app');

/**
 * Harness hygiene: the suite must not read or write the developer's own
 * python/config/config.json.
 *
 * Before the fixture gained WHISPERFLOW_E2E_CONFIG_DIR, `readConfig` created
 * that file when it was missing and `ensureModelsDirInConfig` then wrote the
 * fixture's throwaway userData path into `models_dir` — a directory teardown
 * deletes.  A fresh clone that ran the suite before first launch ended up
 * with a config pointing at a path that no longer existed.  These assertions
 * are deliberately absolute rather than before/after, so they hold no matter
 * which spec ran first.
 */
test.describe('isolation — the suite leaves the project tree alone', () => {
  test('the app reads the fixture config, not the project one', async ({ app }) => {
    const { window, mediaRootDir } = app;

    const config = await window.evaluate(() => window.electronAPI.readConfig());
    expect(config?.SETTING?.media_root_path).toBe(mediaRootDir);
  });

  test('the models_dir write lands in the isolated config', async ({ app }) => {
    const { configDir, userDataDir } = app;

    // ensureModelsDirInConfig fills the empty models_dir on first read.  Give
    // it a beat: it runs lazily when the renderer asks for config.
    const isolated = path.join(configDir, 'config.json');
    await expect.poll(() => {
      try {
        return JSON.parse(fs.readFileSync(isolated, 'utf-8'))?.SETTING?.models_dir || '';
      } catch (_) {
        return '';
      }
    }, { timeout: 10_000 }).not.toBe('');

    const written = JSON.parse(fs.readFileSync(isolated, 'utf-8')).SETTING.models_dir;
    expect(written.startsWith(userDataDir)).toBe(true);
  });

  test('the project config carries no throwaway temp path', async ({ app }) => {
    const { projectConfigPath } = app;

    if (!fs.existsSync(projectConfigPath)) return;   // fresh clone: nothing to check

    const raw = fs.readFileSync(projectConfigPath, 'utf-8');
    // The poisoning signature: a models_dir inside the OS temp dir, or any
    // reference to a fixture directory name.
    expect(raw).not.toContain('wfs-e2e-');
    const modelsDir = JSON.parse(raw)?.SETTING?.models_dir || '';
    if (modelsDir) {
      expect(modelsDir.startsWith(os.tmpdir())).toBe(false);
    }
  });
});
