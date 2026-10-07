import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Settings tab is generated entirely from config.metadata.json's
 * fieldGroups crossed with the keys actually present in config.json, and
 * every mismatch is silent:
 *
 *   - a fieldGroups key absent from the config template never renders
 *   - a config key in no group lands in a trailing "Other" card
 *   - a missing locale key renders as an empty label
 *   - the widget is inferred from the VALUE, so "False" gives a checkbox
 *     while false (a real boolean) gives a text input
 *
 * config.json itself is gitignored — config.example.json is the only place
 * new defaults can ship, and config-manager.js merges it into an existing
 * user's config on read.
 */

const root = path.resolve(import.meta.dirname, '../..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf-8'));

const metadata = readJson('python/config/config.metadata.json').settingsUi;
const template = readJson('python/config/config.example.json').SETTING;
const locales = {
  en: readJson('locales/en/settings.json'),
  'zh-TW': readJson('locales/zh-TW/settings.json'),
};

// Keys that live in APP_SETTINGS rather than the transcription config.
const APP_LEVEL_KEYS = new Set(['pythonPath', 'uiLanguage']);

const groupKeys = metadata.fieldGroups.flatMap((group) => group.keys || []);

describe('settings metadata', () => {
  it.each(metadata.fieldGroups.map((group) => group.id))(
    'group %s has a title in both locales',
    (id) => {
      for (const [locale, strings] of Object.entries(locales)) {
        expect(strings.groups[id]?.title, `${locale}: groups.${id}.title`).toBeTruthy();
      }
    },
  );

  it.each(metadata.fieldGroups.map((group) => [group.id, group.segment]))(
    'group %s targets a real segment (%s)',
    (id, segment) => {
      expect(Object.keys(locales.en.segments)).toContain(segment);
    },
  );

  it.each(groupKeys)('%s exists in the config template so it actually renders', (key) => {
    if (APP_LEVEL_KEYS.has(key)) return;
    expect(template).toHaveProperty(key);
  });

  it('leaves no config key ungrouped, which would land it in the Other card', () => {
    const hidden = new Set(metadata.hiddenFieldKeys || []);
    const grouped = new Set(groupKeys);
    const ungrouped = Object.keys(template).filter((key) => !grouped.has(key) && !hidden.has(key));
    expect(ungrouped).toEqual([]);
  });
});

describe('diarization settings', () => {
  const KEYS = ['diarize', 'diarize_num_speakers', 'speaker_label_template', 'diarize_threshold'];

  it('are all in the diarization group, in the transcription segment', () => {
    const group = metadata.fieldGroups.find((entry) => entry.id === 'diarization');
    expect(group).toBeDefined();
    expect(group.segment).toBe('transcription');
    expect(group.keys).toEqual(KEYS);
    // Not collapsed by default: collapse state is per-group, so hiding the
    // card would hide the on/off switch itself.
    expect(group.defaultCollapsed).toBeUndefined();
  });

  it('sits between the VAD and advanced groups', () => {
    const order = metadata.fieldGroups.map((group) => group.id);
    expect(order.indexOf('diarization')).toBe(order.indexOf('vad') + 1);
    expect(order.indexOf('diarization')).toBeLessThan(order.indexOf('advanced'));
  });

  it.each(KEYS)('%s has a label and description in both locales', (key) => {
    for (const [locale, strings] of Object.entries(locales)) {
      expect(strings.fields[key]?.label, `${locale}: fields.${key}.label`).toBeTruthy();
      expect(strings.fields[key]?.description, `${locale}: fields.${key}.description`).toBeTruthy();
    }
  });

  it('seeds values in the string form the widget inference needs', () => {
    // inferFieldType: enumOptions -> select, exactly 'True'/'False' ->
    // checkbox, numeric-and-non-empty -> number, else text.
    expect(template.diarize).toBe('False');
    expect(template.diarize_num_speakers).toBe('0');
    expect(template.diarize_threshold).toBe('0.5');
    expect(Number.isNaN(Number(template.speaker_label_template))).toBe(true);
    for (const key of KEYS) {
      expect(metadata.enumOptions).not.toHaveProperty(key);
    }
  });

  it('keeps the label template out of the path-browser field lists', () => {
    // "Speaker {n}" is not a path; a Browse button next to it would be
    // nonsense.
    const pathKeys = [...(metadata.pathFieldKeys.folder || []), ...(metadata.pathFieldKeys.file || [])];
    for (const key of KEYS) {
      expect(pathKeys).not.toContain(key);
    }
  });
});
