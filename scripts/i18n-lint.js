#!/usr/bin/env node
'use strict';

/**
 * i18n-lint — verify that every locale JSON file has the same set of
 * translation keys as every other locale.  Run as part of CI so we
 * can't accidentally ship a zh-TW key without a matching en value
 * (or vice versa).
 *
 * Usage:
 *   node scripts/i18n-lint.js
 *
 * Exit codes:
 *   0  — all locales consistent
 *   1  — one or more keys missing in at least one locale
 *   2  — a namespace file is missing entirely in at least one locale
 *   3  — structural mismatch (a key is a leaf in one locale and a
 *        branch in another)
 */

const fs = require('fs');
const path = require('path');

const LOCALES_ROOT = path.resolve(__dirname, '..', 'locales');

function readLocales(root) {
  const result = {};
  for (const lang of fs.readdirSync(root)) {
    const langDir = path.join(root, lang);
    if (!fs.statSync(langDir).isDirectory()) continue;
    result[lang] = {};
    for (const file of fs.readdirSync(langDir)) {
      if (!file.endsWith('.json')) continue;
      const ns = file.slice(0, -5);
      try {
        result[lang][ns] = JSON.parse(fs.readFileSync(path.join(langDir, file), 'utf-8'));
      } catch (err) {
        console.error(`[i18n-lint] Failed to parse ${lang}/${file}: ${err.message}`);
        process.exit(4);
      }
    }
  }
  return result;
}

/** Flatten a nested object into dot-separated keys. Records value type
 *  so we can detect structural mismatches (leaf vs. branch). */
function flatten(obj, prefix = '') {
  const out = new Map();
  for (const [k, v] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [subKey, subType] of flatten(v, full)) {
        out.set(subKey, subType);
      }
    } else {
      out.set(full, typeof v);
    }
  }
  return out;
}

function compareNamespaces(locales) {
  const langs = Object.keys(locales);
  if (langs.length < 2) {
    console.log('[i18n-lint] Only one locale found — nothing to compare.');
    return { exitCode: 0 };
  }

  const namespaceSets = langs.map((lang) => new Set(Object.keys(locales[lang])));
  const allNamespaces = new Set();
  for (const set of namespaceSets) {
    for (const ns of set) allNamespaces.add(ns);
  }

  const missingNamespaces = [];
  for (const ns of allNamespaces) {
    for (const lang of langs) {
      if (!locales[lang][ns]) {
        missingNamespaces.push({ lang, ns });
      }
    }
  }

  if (missingNamespaces.length > 0) {
    console.error('[i18n-lint] Missing namespace files:');
    for (const { lang, ns } of missingNamespaces) {
      console.error(`  - ${lang}/${ns}.json`);
    }
    return { exitCode: 2 };
  }

  const missingKeys = [];
  const typeMismatches = [];

  for (const ns of allNamespaces) {
    const flats = langs.map((lang) => [lang, flatten(locales[lang][ns])]);
    const unionKeys = new Set();
    for (const [, map] of flats) {
      for (const k of map.keys()) unionKeys.add(k);
    }

    for (const key of unionKeys) {
      const types = flats.map(([lang, map]) => [lang, map.get(key)]);
      const missingIn = types.filter(([, t]) => t === undefined).map(([lang]) => lang);
      if (missingIn.length > 0) {
        for (const lang of missingIn) {
          missingKeys.push({ lang, ns, key });
        }
        continue;
      }
      const uniqueTypes = new Set(types.map(([, t]) => t));
      if (uniqueTypes.size > 1) {
        typeMismatches.push({ ns, key, types: types.map(([l, t]) => `${l}:${t}`).join(', ') });
      }
    }
  }

  if (typeMismatches.length > 0) {
    console.error('[i18n-lint] Structural mismatches (key is leaf in one locale, branch in another):');
    for (const { ns, key, types } of typeMismatches) {
      console.error(`  - ${ns}:${key} (${types})`);
    }
    return { exitCode: 3 };
  }

  if (missingKeys.length > 0) {
    console.error('[i18n-lint] Missing keys:');
    const byLang = new Map();
    for (const { lang, ns, key } of missingKeys) {
      if (!byLang.has(lang)) byLang.set(lang, []);
      byLang.get(lang).push(`${ns}:${key}`);
    }
    for (const [lang, keys] of byLang) {
      console.error(`  [${lang}] missing ${keys.length}:`);
      for (const k of keys.slice(0, 30)) console.error(`    - ${k}`);
      if (keys.length > 30) console.error(`    … and ${keys.length - 30} more`);
    }
    return { exitCode: 1 };
  }

  let totalKeys = 0;
  for (const ns of allNamespaces) {
    totalKeys += flatten(locales[langs[0]][ns]).size;
  }
  console.log(`[i18n-lint] OK — ${langs.length} locales, ${allNamespaces.size} namespaces, ${totalKeys} keys per locale.`);
  return { exitCode: 0 };
}

const locales = readLocales(LOCALES_ROOT);
const { exitCode } = compareNamespaces(locales);
process.exit(exitCode);
