'use strict';

/**
 * Vitest configuration — main-process unit tests.
 * ===============================================
 *
 * Two settings here are load-bearing, not taste:
 *
 * `include` is narrowed to tests/unit/.  Vitest's default glob is
 * `**\/*.{test,spec}.*`, which would also collect e2e/specs/*.spec.js —
 * those are Playwright tests, they import a Playwright fixture, and they
 * fail immediately under Vitest.  `npm run test:e2e` owns those.
 *
 * Test files live in tests/unit/ rather than next to the modules they
 * cover because electron-builder.yml's `files:` list starts with `src/**`,
 * so a colocated *.test.js would be packaged into the shipped asar.
 *
 * The modules under test are plain CommonJS and require only fs/os/path —
 * no electron — so the default `node` environment is enough.  Test files
 * themselves are ES modules (Vitest is ESM-only) and import the CommonJS
 * modules as a default export, which is the form Vite's interop always
 * produces.
 */
module.exports = {
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
  },
};
