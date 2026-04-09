'use strict';

const fs = require('fs');
const path = require('path');

function cloneConfig(configObj = {}) {
  return JSON.parse(JSON.stringify(configObj));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeConfig(configObj = {}, baseConfig = {}) {
  const normalized = cloneConfig(baseConfig);

  for (const [section, value] of Object.entries(configObj)) {
    if (isPlainObject(value) && isPlainObject(normalized[section])) {
      normalized[section] = { ...normalized[section], ...value };
      continue;
    }

    if (isPlainObject(value)) {
      normalized[section] = { ...value };
      continue;
    }

    normalized[section] = value;
  }

  return normalized;
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return fallback;
  }
}

function findTemplatePath(filePath) {
  let currentDir = path.dirname(filePath);

  while (true) {
    const candidate = path.join(currentDir, 'config.example.json');
    if (fs.existsSync(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function getDefaultConfig(filePath) {
  const templatePath = findTemplatePath(filePath);
  const templateConfig = templatePath ? readJsonFile(templatePath, {}) : {};
  return normalizeConfig(templateConfig);
}

function ensureConfigFile(filePath, defaultConfig) {
  if (fs.existsSync(filePath)) return;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
  } catch (_) {
    // Ignore bootstrap write failures and fall back to in-memory defaults.
  }
}

function readConfig(filePath) {
  const defaultConfig = getDefaultConfig(filePath);
  ensureConfigFile(filePath, defaultConfig);

  const config = readJsonFile(filePath, defaultConfig);
  return normalizeConfig(config, defaultConfig);
}

function writeConfig(filePath, configObj) {
  const normalized = normalizeConfig(configObj, getDefaultConfig(filePath));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
}

/**
 * Scan the config directory for subdirectories containing a config.json.
 * Returns [{ name: 'JP', configPath: '/path/to/JP/config.json' }, ...]
 * plus a 'default' entry for the root config.json.
 */
function getProfileList(configDir) {
  const rootConfig = path.join(configDir, 'config.json');
  const profiles = [{ name: 'default', configPath: rootConfig }];

  try {
    const entries = fs.readdirSync(configDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(configDir, entry.name, 'config.json');
      if (fs.existsSync(candidate)) {
        profiles.push({ name: entry.name, configPath: candidate });
      }
    }
  } catch (e) {
    // ignore read errors
  }

  return profiles;
}

function copyProfileToActive(profileConfigPath, activeConfigPath) {
  writeConfig(activeConfigPath, readConfig(profileConfigPath));
}

module.exports = { readConfig, writeConfig, getProfileList, copyProfileToActive };
