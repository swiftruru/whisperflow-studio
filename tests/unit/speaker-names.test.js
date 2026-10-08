import { describe, expect, it } from 'vitest';

// A renderer ES module with no DOM in it, imported directly — the same
// shape as error-state.test.js.
import {
  applySpeakerNames,
  collectNames,
  formatClock,
  formatDuration,
  namesEqual,
  summarizeSpeakers,
} from '../../src/renderer/lib/speaker-names.js';

// Two speakers, four turns.  `speakerLabel` only on the first cue of each
// turn, which is exactly what diarization writes and what the whole
// prefix-once-per-turn behaviour depends on.
const SEGMENTS = [
  { start: 0, end: 10, text: 'a long opening', speaker: 0, speakerLabel: 'Speaker 1' },
  { start: 10, end: 12, text: 'still me', speaker: 0, speakerLabel: null },
  { start: 12, end: 30, text: 'the other person at length', speaker: 1, speakerLabel: 'Speaker 2' },
  { start: 30, end: 31, text: 'brief', speaker: 1, speakerLabel: null },
  { start: 31, end: 36, text: 'back again', speaker: 0, speakerLabel: 'Speaker 1' },
];

describe('applySpeakerNames', () => {
  it('substitutes the name into the cues that carry a label', () => {
    const out = applySpeakerNames(SEGMENTS, { 0: 'Sandy' });
    expect(out[0].speakerLabel).toBe('Sandy');
    expect(out[4].speakerLabel).toBe('Sandy');
  });

  it('never gives a label to a cue that had none', () => {
    // The regression that would print a prefix on every line of the
    // transcript instead of once per turn.  `names[seg.speaker] ??
    // seg.speakerLabel` is the wrong shape; this is the right one.
    const out = applySpeakerNames(SEGMENTS, { 0: 'Sandy', 1: 'LINE BANK' });
    expect(out[1].speakerLabel).toBeNull();
    expect(out[3].speakerLabel).toBeNull();
    expect(out.filter((s) => s.speakerLabel).length)
      .toBe(SEGMENTS.filter((s) => s.speakerLabel).length);
  });

  it('leaves speakers nobody named alone', () => {
    const out = applySpeakerNames(SEGMENTS, { 0: 'Sandy' });
    expect(out[2].speakerLabel).toBe('Speaker 2');
  });

  it('returns the array untouched when there are no names', () => {
    expect(applySpeakerNames(SEGMENTS, null)).toBe(SEGMENTS);
  });

  it('does not mutate the segments it is given', () => {
    const before = JSON.parse(JSON.stringify(SEGMENTS));
    applySpeakerNames(SEGMENTS, { 0: 'Sandy', 1: 'LINE BANK' });
    expect(SEGMENTS).toEqual(before);
  });

  it('survives a segment with no speaker', () => {
    const segments = [{ start: 0, end: 1, text: 'x', speaker: null, speakerLabel: null }];
    expect(applySpeakerNames(segments, { 0: 'Sandy' })[0].speakerLabel).toBeNull();
  });
});

describe('summarizeSpeakers', () => {
  it('groups by speaker and totals their talk time', () => {
    const [first, second] = summarizeSpeakers(SEGMENTS);
    expect(first.speaker).toBe(0);
    expect(first.totalSeconds).toBe(10 + 2 + 5);
    expect(first.cueCount).toBe(3);
    expect(second.speaker).toBe(1);
    expect(second.totalSeconds).toBe(18 + 1);
  });

  it('orders by speaker index, which is first-appearance order', () => {
    // Speaker 1 talks longer in total, but speaker 0 spoke first, and
    // index order is the order the user met these voices in.
    expect(summarizeSpeakers(SEGMENTS).map((s) => s.speaker)).toEqual([0, 1]);
  });

  it('carries the label from the first turn of that speaker', () => {
    expect(summarizeSpeakers(SEGMENTS)[1].label).toBe('Speaker 2');
  });

  it('picks the longest cues as excerpts, shown in timeline order', () => {
    const [first] = summarizeSpeakers(SEGMENTS, { excerpts: 2 });
    // Longest two of speaker 0 are the 10s and the 5s, not the 2s.
    expect(first.excerpts.map((e) => e.text)).toEqual(['a long opening', 'back again']);
  });

  it('returns every cue when asked for more excerpts than exist', () => {
    expect(summarizeSpeakers(SEGMENTS, { excerpts: 99 })[1].excerpts).toHaveLength(2);
  });

  it('ignores segments with no integer speaker', () => {
    // Diarization off, or it found no turns: there is nobody to name.
    expect(summarizeSpeakers([
      { start: 0, end: 1, text: 'x', speaker: null, speakerLabel: null },
    ])).toEqual([]);
  });

  it('is empty for an empty transcript', () => {
    expect(summarizeSpeakers([])).toEqual([]);
  });
});

describe('collectNames', () => {
  it('keys by the speaker index as a string, the way JSON stores it', () => {
    expect(collectNames([{ speaker: 0, name: 'Sandy', label: 'Speaker 1' }]))
      .toEqual({ 0: 'Sandy' });
  });

  it('drops blank fields and trims the rest', () => {
    expect(collectNames([
      { speaker: 0, name: '  Sandy  ', label: 'Speaker 1' },
      { speaker: 1, name: '   ', label: 'Speaker 2' },
      { speaker: 2, name: '', label: 'Speaker 3' },
    ])).toEqual({ 0: 'Sandy' });
  });

  it('drops a name identical to the label diarization produced', () => {
    // Storing "Speaker 2" as a chosen name would outlive a later change
    // to the label template and quietly override it.
    expect(collectNames([{ speaker: 1, name: 'Speaker 2', label: 'Speaker 2' }]))
      .toEqual({});
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [18, '18s'],
    [59, '59s'],
    [60, '1m 00s'],
    [296, '4m 56s'],
    [3600, '1h 00m'],
    [3845, '1h 04m'],
  ])('formats %is as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it('never shows a negative or a NaN', () => {
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
    expect(formatDuration(undefined)).toBe('0s');
  });
});

describe('formatClock', () => {
  it.each([
    [0, '00:00:00'],
    [67, '00:01:07'],
    [3856, '01:04:16'],
  ])('formats %is as %s', (seconds, expected) => {
    expect(formatClock(seconds)).toBe(expected);
  });

  it('floors rather than rounds, so a cue never appears to start late', () => {
    expect(formatClock(67.9)).toBe('00:01:07');
  });
});

describe('namesEqual', () => {
  // The editor's unsaved-changes flag turns on this. Renaming is not part
  // of the text-only undo history, so a false "equal" means a rename
  // followed by an edit and an undo reads as clean: the Save button goes
  // dead and closing the editor does not even prompt.
  it.each([
    ['both empty', null, null],
    ['null against {}', null, {}],
    ['undefined against {}', undefined, {}],
    ['same pairs', { 0: 'Sandy' }, { 0: 'Sandy' }],
    ['same pairs in a different key order', { 0: 'A', 1: 'B' }, { 1: 'B', 0: 'A' }],
  ])('is true for %s', (_label, a, b) => {
    expect(namesEqual(a, b)).toBe(true);
    expect(namesEqual(b, a)).toBe(true);
  });

  it.each([
    ['a name added', null, { 0: 'Sandy' }],
    ['a name removed', { 0: 'Sandy' }, {}],
    ['a name changed', { 0: 'Sandy' }, { 0: 'Sandi' }],
    ['a name moved to another speaker', { 0: 'Sandy' }, { 1: 'Sandy' }],
    ['one more name', { 0: 'A' }, { 0: 'A', 1: 'B' }],
  ])('is false for %s', (_label, a, b) => {
    expect(namesEqual(a, b)).toBe(false);
    expect(namesEqual(b, a)).toBe(false);
  });
});
