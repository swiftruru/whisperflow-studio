'use strict';

/**
 * Changelog reader for the in-app Version history viewer.
 *
 * Dev:    reads `<ELECTRON_APP_ROOT>/changelog/v*.md`
 * Packaged: electron-builder ships `changelog/` under `extraResources`, so
 *           it lives at `process.resourcesPath/changelog/` once installed.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getChangelogDir(electronAppRoot) {
  const devDir = path.join(electronAppRoot || '', 'changelog');
  if (app.isPackaged) {
    const resDir = path.join(process.resourcesPath || '', 'changelog');
    if (fs.existsSync(resDir)) return resDir;
    return devDir;
  }
  return devDir;
}

// Parse "v1.10.2" → [1, 10, 2] for semver-descending sort.  Entries that
// don't match fall back to [0, 0, 0] so they don't crash the sort, but
// they'll land at the end.
function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionsDesc(a, b) {
  const [a0, a1, a2] = parseVersion(a);
  const [b0, b1, b2] = parseVersion(b);
  if (a0 !== b0) return b0 - a0;
  if (a1 !== b1) return b1 - a1;
  return b2 - a2;
}

function listChangelogEntries(electronAppRoot) {
  const dir = getChangelogDir(electronAppRoot);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const entries = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const version = file.slice(0, -3);
    if (!/^v\d+\.\d+\.\d+/.test(version)) continue;
    entries.push({ version, filename: file });
  }
  entries.sort((a, b) => compareVersionsDesc(a.version, b.version));
  return entries;
}

function readChangelogEntry(electronAppRoot, version) {
  if (!/^v\d+\.\d+\.\d+/.test(String(version || ''))) {
    throw new Error(`invalid version: ${version}`);
  }
  const dir = getChangelogDir(electronAppRoot);
  const filePath = path.join(dir, `${version}.md`);
  return fs.readFileSync(filePath, 'utf-8');
}

module.exports = {
  listChangelogEntries,
  readChangelogEntry,
};
