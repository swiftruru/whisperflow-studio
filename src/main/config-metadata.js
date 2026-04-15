'use strict';

const fs = require('fs');

function cloneJson(value = {}) {
  return JSON.parse(JSON.stringify(value));
}

function getEmptyMetadata() {
  return {
    settingsUi: {
      enumOptions: {},
      languagePrompts: {},
      pathFieldKeys: {
        folder: [],
        file: [],
      },
    },
    appRuntime: {
      windowDefaults: {},
      bundledPython: {},
      knownPythonPaths: {},
    },
    media: {
      supportedMediaExtensions: [],
      subtitleExtensions: [],
    },
  };
}

function readConfigMetadata(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return getEmptyMetadata();
  }
}

function getSupportedMediaExtensions(filePath) {
  const metadata = readConfigMetadata(filePath);
  return cloneJson(metadata.media?.supportedMediaExtensions || [])
    .filter((ext) => typeof ext === 'string')
    .map((ext) => ext.replace(/^\./, ''));
}

function getAppRuntimeConfig(filePath) {
  const metadata = readConfigMetadata(filePath);
  return cloneJson(metadata.appRuntime || {});
}

module.exports = {
  readConfigMetadata,
  getSupportedMediaExtensions,
  getAppRuntimeConfig,
};
