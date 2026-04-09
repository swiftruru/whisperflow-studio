'use strict';

const fs = require('fs');
const path = require('path');
const { getKnownPoetryPaths } = require('./config-metadata');

function resolvePoetryPath(userOverride, configMetadataPath) {
  if (userOverride && fs.existsSync(userOverride)) {
    return userOverride;
  }

  const candidates = getKnownPoetryPaths(configMetadataPath);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Try PATH as fallback
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const poetryExe = process.platform === 'win32' ? 'poetry.exe' : 'poetry';
  for (const dir of pathDirs) {
    const candidate = path.join(dir, poetryExe);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
module.exports = { resolvePoetryPath };
