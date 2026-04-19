'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  // Electron tests share a single ELECTRON_RUN_AS_NODE env and would
  // collide on global shortcuts / userData paths if run concurrently
  // — keep it serial.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
