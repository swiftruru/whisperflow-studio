'use strict';

const fs = require('fs');
const os = require('os');

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
      macPathPrefixes: [],
      windowDefaults: {},
      knownPoetryPaths: {},
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

function expandHomePath(value) {
  return typeof value === 'string'
    ? value.replace(/\$\{HOME\}/g, os.homedir())
    : value;
}

function getKnownPoetryPaths(filePath, platform = process.platform) {
  const config = getAppRuntimeConfig(filePath);
  return cloneJson(config.knownPoetryPaths?.[platform] || []).map(expandHomePath);
}

module.exports = {
  readConfigMetadata,
  getSupportedMediaExtensions,
  getAppRuntimeConfig,
  getKnownPoetryPaths,
};
