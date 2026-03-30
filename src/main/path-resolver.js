'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const KNOWN_POETRY_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'poetry'),
  '/opt/homebrew/bin/poetry',
  '/usr/local/bin/poetry',
  '/usr/bin/poetry',
];

const KNOWN_POETRY_PATHS_WIN = [
  path.join(os.homedir(), 'AppData', 'Roaming', 'Python', 'Scripts', 'poetry.exe'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Scripts', 'poetry.exe'),
];

function resolvePoetryPath(userOverride) {
  if (userOverride && fs.existsSync(userOverride)) {
    return userOverride;
  }

  const candidates = process.platform === 'win32'
    ? KNOWN_POETRY_PATHS_WIN
    : KNOWN_POETRY_PATHS;

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

function resolvePythonPath(userOverride) {
  if (userOverride && fs.existsSync(userOverride)) {
    return userOverride;
  }

  const pythonExe = process.platform === 'win32' ? 'python.exe' : 'python3';
  const fallbacks = ['python3', 'python'];
  const pathDirs = (process.env.PATH || '').split(path.delimiter);

  for (const name of fallbacks) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return 'python3';
}

module.exports = { resolvePoetryPath, resolvePythonPath };
