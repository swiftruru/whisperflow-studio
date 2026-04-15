#!/usr/bin/env node
'use strict';

/**
 * Wipe the local electron-builder output and drop a Spotlight marker so
 * macOS LaunchServices never indexes the produced .app as "another
 * WhisperFlow Studio" alongside the one in /Applications.
 *
 * Why this exists
 * ---------------
 * macOS LaunchServices catalogs every .app under the user's home
 * directory by bundle id (`com.ruru.whisperflow-studio`).  When two
 * .apps share the same bundle id — typically the official
 * `/Applications/WhisperFlow Studio.app` and a leftover
 * `dist/mac-arm64/WhisperFlow Studio.app` from a past
 * `npm run build:mac` — double-clicking from anywhere can launch
 * EITHER copy, non-deterministically.  That's how a stale v1.1.0 build
 * from months ago can get launched when the user thinks they're testing
 * the freshly-installed v1.4.0 from the DMG.
 *
 * The fix has two parts:
 *
 * 1. Always start each build with a clean `dist/` so we never carry
 *    stale platform sub-folders forward.
 *
 * 2. Place an empty file named `.metadata_never_index` at the root of
 *    `dist/` immediately after recreating it.  Spotlight (and therefore
 *    LaunchServices) honors this marker — any folder containing it is
 *    skipped entirely, along with all of its descendants.  Local test
 *    builds will still produce a working .app you can manually open by
 *    its full path, but they will never be conflated with the real
 *    installed app via LaunchServices' bundle-id lookup.
 *
 * On Windows / Linux the marker file is harmless (just an empty file)
 * and the rmSync still cleans the directory, so we run the same script
 * everywhere.
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

if (process.platform === 'darwin') {
  fs.writeFileSync(
    path.join(distDir, '.metadata_never_index'),
    '# Tells macOS Spotlight not to index this build output directory.\n'
    + '# Without this, electron-builder leftovers in dist/mac-* can be\n'
    + '# discovered by LaunchServices and confused with the real install\n'
    + '# in /Applications.  See scripts/clean-dist.js for full context.\n',
  );
  console.log(`[clean-dist] cleaned ${distDir} + dropped Spotlight non-index marker`);
} else {
  console.log(`[clean-dist] cleaned ${distDir}`);
}
