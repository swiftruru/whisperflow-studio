'use strict';

const fs = require('fs');
const path = require('path');

function ensureParentDirectory(filePath) {
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, { recursive: true });
}

function createQueueStorage(filePath, options = {}) {
  const debounceMs = options.debounceMs ?? 250;

  let pendingTimer = null;
  let lastSerialized = null;

  function load(fallback = null) {
    try {
      const contents = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(contents);
      lastSerialized = JSON.stringify(parsed, null, 2);
      return parsed;
    } catch (_) {
      return fallback;
    }
  }

  function writeNow(payload) {
    const serialized = JSON.stringify(payload, null, 2);
    if (serialized === lastSerialized) return;

    ensureParentDirectory(filePath);
    fs.writeFileSync(filePath, serialized, 'utf-8');
    lastSerialized = serialized;
  }

  function save(payload) {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      writeNow(payload);
    }, debounceMs);
  }

  function flush(payload) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    writeNow(payload);
  }

  return {
    flush,
    load,
    path: filePath,
    save,
  };
}

module.exports = {
  createQueueStorage,
};
