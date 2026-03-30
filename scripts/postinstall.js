'use strict';

// macOS-only dev setup: rename Electron.app → WhisperFlow Studio.app,
// patch Info.plist display name, and regenerate icon.icns.
// On other platforms this script exits immediately.

if (process.platform !== 'darwin') {
  console.log('[postinstall] Non-macOS platform, skipping macOS dev setup.');
  process.exit(0);
}

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT        = path.resolve(__dirname, '..');
const DIST        = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OLD_APP     = path.join(DIST, 'Electron.app');
const NEW_APP     = path.join(DIST, 'WhisperFlow Studio.app');
const PATH_TXT    = path.join(ROOT, 'node_modules', 'electron', 'path.txt');
const PLIST       = path.join(NEW_APP, 'Contents', 'Info.plist');
const PLISTBUDDY  = '/usr/libexec/PlistBuddy';

try {
  if (fs.existsSync(OLD_APP)) {
    fs.renameSync(OLD_APP, NEW_APP);
    console.log('[postinstall] Renamed Electron.app → WhisperFlow Studio.app');
  }

  if (fs.existsSync(NEW_APP)) {
    fs.writeFileSync(PATH_TXT, 'WhisperFlow Studio.app/Contents/MacOS/Electron');
    execSync(`${PLISTBUDDY} -c "Set :CFBundleDisplayName WhisperFlow Studio" "${PLIST}"`, { stdio: 'ignore' });
    execSync(`${PLISTBUDDY} -c "Set :CFBundleName WhisperFlow Studio" "${PLIST}"`, { stdio: 'ignore' });
    console.log('[postinstall] Patched Info.plist display name.');
  }

  require('./patch-icon.js');
} catch (err) {
  console.warn('[postinstall] macOS setup error (non-fatal):', err.message);
}
