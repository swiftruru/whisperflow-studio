'use strict';

const fs = require('fs');
const path = require('path');

function readConfig(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function writeConfig(filePath, configObj) {
  fs.writeFileSync(filePath, JSON.stringify(configObj, null, 2), 'utf-8');
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
  fs.copyFileSync(profileConfigPath, activeConfigPath);
}

module.exports = { readConfig, writeConfig, getProfileList, copyProfileToActive };
