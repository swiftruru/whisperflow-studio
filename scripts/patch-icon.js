'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC_PNG = path.join(ROOT, 'assets', 'icon-mac.png');
const ICONSET = path.join(require('os').tmpdir(), 'whisperflow.iconset');
const ICNS_OUT = path.join(ROOT, 'assets', 'icon.icns');
const BUNDLE_ICON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'WhisperFlow Studio.app', 'Contents', 'Resources', 'electron.icns');

if (!fs.existsSync(SRC_PNG)) {
  console.log('[patch-icon] assets/icon-mac.png not found, skipping.');
  process.exit(0);
}

fs.mkdirSync(ICONSET, { recursive: true });

const sizes = [
  ['icon_16x16.png',      16],
  ['icon_16x16@2x.png',   32],
  ['icon_32x32.png',      32],
  ['icon_32x32@2x.png',   64],
  ['icon_128x128.png',   128],
  ['icon_128x128@2x.png',256],
  ['icon_256x256.png',   256],
  ['icon_256x256@2x.png',512],
  ['icon_512x512.png',   512],
  ['icon_512x512@2x.png',1024],
];

for (const [name, size] of sizes) {
  execSync(`sips -z ${size} ${size} "${SRC_PNG}" --out "${path.join(ICONSET, name)}"`, { stdio: 'ignore' });
}

execSync(`iconutil -c icns "${ICONSET}" -o "${ICNS_OUT}"`);

if (fs.existsSync(path.dirname(BUNDLE_ICON))) {
  fs.copyFileSync(ICNS_OUT, BUNDLE_ICON);
  console.log('[patch-icon] icon.icns patched into Electron bundle.');
} else {
  console.log('[patch-icon] Electron bundle not found, skipping bundle patch.');
}
