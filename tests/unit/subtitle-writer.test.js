import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import subtitleWriter from '../../src/main/subtitle-writer.js';

const {
  SPEAKER_PREFIX_FORMAT,
  TXT_PARAGRAPH_GAP,
  normalizeCueText,
  formatSpeakerPrefix,
  formatSrtTime,
  formatVttTime,
  generateSrt,
  generateVtt,
  generateTxt,
  patchJsonWithEdits,
} = subtitleWriter;

describe('timestamp formatting', () => {
  it('formats SRT timestamps with a comma and always includes hours', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(1.5)).toBe('00:00:01,500');
    expect(formatSrtTime(3661.123)).toBe('01:01:01,123');
  });

  it('formats VTT timestamps with a dot', () => {
    expect(formatVttTime(1.5)).toBe('00:00:01.500');
    // NOTE: Python's write_vtt omits the HH: block under an hour, this one
    // does not.  Pinned as-is; the editor only rewrites files that already
    // exist, so the two never interleave inside one file.
    expect(formatVttTime(12.5)).toBe('00:00:12.500');
  });

  it('clamps negative and unparseable input to zero', () => {
    expect(formatSrtTime(-5)).toBe('00:00:00,000');
    expect(formatSrtTime('nonsense')).toBe('00:00:00,000');
    expect(formatSrtTime(undefined)).toBe('00:00:00,000');
  });
});

describe('generateSrt', () => {
  it('writes numbered cues', () => {
    const srt = generateSrt([
      { start: 0, end: 1.5, text: 'Hello world' },
      { start: 2, end: 4.25, text: 'Second cue' },
    ]);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n'
      + '2\n00:00:02,000 --> 00:00:04,250\nSecond cue\n',
    );
  });

  it('trims cue text and skips empty cues', () => {
    const srt = generateSrt([
      { start: 0, end: 1, text: '  padded  ' },
      { start: 1, end: 2, text: '   ' },
      { start: 2, end: 3, text: 'kept' },
    ]);
    expect(srt).toContain('padded');
    expect(srt).not.toContain('   \n');
    // Empty cues are skipped but the index comes from the ORIGINAL array
    // position, so numbering has a gap.  Pinned to document the behaviour.
    expect(srt.split('\n')[0]).toBe('1');
    expect(srt).toContain('3\n00:00:02,000 --> 00:00:03,000\nkept');
  });
});

describe('generateVtt', () => {
  it('writes a WEBVTT header and unnumbered cues', () => {
    const vtt = generateVtt([{ start: 0, end: 1.5, text: 'Hello world' }]);
    expect(vtt).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello world\n');
  });

  it('does not emit a voice tag', () => {
    // The app previews VTT through the SRT parser, which would render a
    // <v> tag verbatim.
    const vtt = generateVtt([{ start: 0, end: 1, text: 'hi' }]);
    expect(vtt).not.toContain('<v');
  });
});

describe('generateTxt', () => {
  it('writes one trimmed segment per line with a trailing newline', () => {
    expect(generateTxt([
      { start: 0, end: 1, text: '  line one  ' },
      { start: 1, end: 2, text: 'line two' },
    ])).toBe('line one\nline two\n');
  });
});

describe('patchJsonWithEdits', () => {
  it('rewrites only text and preserves every other field', () => {
    const original = JSON.stringify({
      language: 'zh',
      duration: 12.5,
      segments: [
        { start: 0, end: 1, text: 'old', words: [{ start: 0, end: 1, word: 'old' }] },
      ],
    });

    const patched = JSON.parse(patchJsonWithEdits(original, [{ text: 'new' }]));
    expect(patched.segments[0].text).toBe('new');
    expect(patched.segments[0].words).toEqual([{ start: 0, end: 1, word: 'old' }]);
    expect(patched.segments[0].start).toBe(0);
    expect(patched.language).toBe('zh');
    expect(patched.duration).toBe(12.5);
  });

  it('accepts a bare top-level array', () => {
    const patched = JSON.parse(patchJsonWithEdits('[{"start":0,"end":1,"text":"a"}]', [{ text: 'b' }]));
    expect(patched[0].text).toBe('b');
  });

  it('patches only as far as the shorter of the two arrays', () => {
    const original = JSON.stringify({ segments: [{ text: 'a' }, { text: 'b' }] });
    const patched = JSON.parse(patchJsonWithEdits(original, [{ text: 'A' }]));
    expect(patched.segments.map((s) => s.text)).toEqual(['A', 'b']);
  });

  it('rejects JSON with no segments array', () => {
    expect(() => patchJsonWithEdits('{"nope":true}', [])).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON_SHAPE' }),
    );
  });

  it('ends the file with a newline', () => {
    expect(patchJsonWithEdits('{"segments":[]}', [])).toMatch(/\n$/);
  });
});

describe('speaker prefixes', () => {
  const labelled = [
    { start: 0, end: 1.5, text: 'Hello world', speaker: 0, speakerLabel: 'Speaker 1' },
    { start: 2, end: 4.25, text: 'Second cue', speaker: 1, speakerLabel: 'Speaker 2' },
  ];

  it('uses the same format literal as the Python writers', () => {
    // Python writes the subtitle files; this module regenerates them from
    // the user's edits.  A divergence here silently rewrites every cue on
    // the first save, which no runtime check would catch.
    const pythonSource = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../python/whisperflow/subtitles/writers.py'),
      'utf-8',
    );
    const pythonFormat = pythonSource.match(/^SPEAKER_PREFIX_FORMAT = "(.*)"$/m)?.[1];
    expect(pythonFormat).toBe('[{label}] ');
    expect(SPEAKER_PREFIX_FORMAT).toBe(pythonFormat);
  });

  it('formats a label into a prefix', () => {
    expect(formatSpeakerPrefix('Speaker 1')).toBe('[Speaker 1] ');
    expect(formatSpeakerPrefix('講者 2')).toBe('[講者 2] ');
  });

  it.each([undefined, null, '', '   ', 0, 7, {}])('treats %o as no label', (label) => {
    expect(formatSpeakerPrefix(label)).toBe('');
  });

  it('prefixes SRT cues', () => {
    expect(generateSrt(labelled)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\n[Speaker 1] Hello world\n\n'
      + '2\n00:00:02,000 --> 00:00:04,250\n[Speaker 2] Second cue\n',
    );
  });

  it('prefixes VTT cues without a voice tag', () => {
    const vtt = generateVtt(labelled);
    expect(vtt).toBe(
      'WEBVTT\n\n'
      + '00:00:00.000 --> 00:00:01.500\n[Speaker 1] Hello world\n\n'
      + '00:00:02.000 --> 00:00:04.250\n[Speaker 2] Second cue\n',
    );
    expect(vtt).not.toContain('<v');
  });

  it('prefixes TXT lines', () => {
    expect(generateTxt(labelled)).toBe('[Speaker 1] Hello world\n[Speaker 2] Second cue\n');
  });

  it('is byte-identical to the unlabelled output when there is no label', () => {
    // The regression guard for "diarization off changes nothing".  These
    // are the exact strings the baseline tests above assert.
    const plain = [
      { start: 0, end: 1.5, text: 'Hello world' },
      { start: 2, end: 4.25, text: 'Second cue' },
    ];
    expect(generateSrt(plain)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n'
      + '2\n00:00:02,000 --> 00:00:04,250\nSecond cue\n',
    );
    expect(generateVtt(plain)).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello world\n\n00:00:02.000 --> 00:00:04.250\nSecond cue\n');
    expect(generateTxt(plain)).toBe('Hello world\nSecond cue\n');

    // Explicit nulls, which is what transcript-reader.js produces for a
    // transcript written before diarization existed.
    const nulls = plain.map((seg) => ({ ...seg, speaker: null, speakerLabel: null }));
    expect(generateSrt(nulls)).toBe(generateSrt(plain));
    expect(generateVtt(nulls)).toBe(generateVtt(plain));
    expect(generateTxt(nulls)).toBe(generateTxt(plain));
  });

  it('does not turn a blank segment into a bare label', () => {
    const srt = generateSrt([{ start: 0, end: 1, text: '   ', speakerLabel: 'Speaker 1' }]);
    expect(srt).toBe('');
  });

  it('leaves speaker fields in the JSON untouched when patching text', () => {
    // patchJsonWithEdits only assigns `text`, and the editor's text is
    // clean, so the on-disk JSON keeps both the speaker fields and a
    // markup-free text.  This is the whole reason the prefix is applied at
    // write time rather than stored.
    const original = JSON.stringify({
      segments: [{
        start: 0,
        end: 1,
        text: 'old',
        speaker: 2,
        speaker_label: 'Speaker 3',
        words: [{ start: 0, end: 1, word: 'old', speaker: 2 }],
      }],
    });
    const patched = JSON.parse(patchJsonWithEdits(original, [{
      text: 'new',
      speaker: 2,
      speakerLabel: 'Speaker 3',
    }]));
    expect(patched.segments[0]).toEqual({
      start: 0,
      end: 1,
      text: 'new',
      speaker: 2,
      speaker_label: 'Speaker 3',
      words: [{ start: 0, end: 1, word: 'old', speaker: 2 }],
    });
  });
});

describe('TXT paragraphs', () => {
  // The same hand-written contract python/whisperflow/tests/test_writers.py
  // reads.  Python writes the TXT and this module regenerates it from the
  // user's edits, so the two have to agree byte for byte.
  const contract = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../fixtures/txt-paragraphs.json'),
      'utf-8',
    ),
  );
  const pythonSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../python/whisperflow/subtitles/writers.py'),
    'utf-8',
  );

  it('uses the same paragraph gap as the contract and as Python', () => {
    expect(TXT_PARAGRAPH_GAP).toBe(contract.paragraphGapSeconds);
    expect(pythonSource).toContain(`TXT_PARAGRAPH_GAP = ${TXT_PARAGRAPH_GAP.toFixed(1)}`);
  });

  it('uses the same CJK ranges as Python', () => {
    // Each language's own "right" API disagrees on fullwidth Latin and
    // other edges, so both sides declare an explicit range set instead.
    for (const [low, high] of [
      [0x3000, 0x303f], [0x3040, 0x30ff], [0x3400, 0x4dbf],
      [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xf900, 0xfaff], [0xff00, 0xff60],
    ]) {
      const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
      expect(pythonSource).toContain(`(${hex(low)}, ${hex(high)})`);
    }
  });

  it.each(contract.cases.map((c) => [c.name, c]))('%s', (_name, testCase) => {
    // The contract uses the Python JSON shape; transcript-reader.js does
    // the same snake-to-camel mapping for real files.
    const segments = testCase.segments.map((s) => ({ ...s, speakerLabel: s.speaker_label }));
    expect(generateTxt(segments, { paragraphs: testCase.paragraphs })).toBe(testCase.expected);
  });

  it('defaults to one cue per line', () => {
    const segments = [
      { start: 0, end: 1, text: 'line one', speaker: 0, speakerLabel: 'Speaker 1' },
      { start: 1, end: 2, text: 'line two', speaker: 0 },
    ];
    expect(generateTxt(segments)).toBe('[Speaker 1] line one\nline two\n');
    expect(generateTxt(segments)).toBe(generateTxt(segments, { paragraphs: false }));
  });
});

describe('normalizeCueText', () => {
  it('collapses a blank line, which would truncate the file', () => {
    // A blank line terminates an SRT or WebVTT cue block, so every
    // parser silently drops the rest of the file -- including this app's
    // own transcript-reader.js.
    expect(normalizeCueText('a\n\nb')).toBe('a\nb');
    expect(normalizeCueText('a\n\n\n\nb')).toBe('a\nb');
    expect(normalizeCueText('a\n   \nb')).toBe('a\nb');
  });

  it('leaves a legal multi-line cue alone, however many lines', () => {
    // Uncapped by default on purpose: capping at a guessed 2 here would
    // destroy a legitimate three-line cue for anyone who raised
    // subtitle_max_lines.
    expect(normalizeCueText('line one\nline two')).toBe('line one\nline two');
    expect(normalizeCueText('one\ntwo\nthree')).toBe('one\ntwo\nthree');
  });

  it('folds surplus lines into the last allowed one when capped', () => {
    // Folded, never dropped: losing the user's words is worse than one
    // long line.
    expect(normalizeCueText('one\ntwo\nthree\nfour', 2)).toBe('one\ntwo three four');
    expect(normalizeCueText('one\ntwo\nthree', 3)).toBe('one\ntwo\nthree');
    expect(normalizeCueText('one\ntwo', 1)).toBe('one two');
  });

  it('normalises CRLF and trims trailing whitespace', () => {
    expect(normalizeCueText('a\r\nb')).toBe('a\nb');
    expect(normalizeCueText('a  \nb\t')).toBe('a\nb');
  });

  it('is idempotent', () => {
    for (const text of ['a\n\nb\nc\nd', 'line one\nline two', '', '   ', 'a\r\n\r\nb']) {
      const once = normalizeCueText(text, 2);
      expect(normalizeCueText(once, 2)).toBe(once);
    }
  });

  it('is applied on every save path', () => {
    // cueText runs it, so no generator can emit a blank line inside a
    // cue whatever the renderer did.
    const segments = [
      { start: 0, end: 1, text: 'a\n\nb' },
      { start: 2, end: 3, text: 'next' },
    ];
    for (const out of [generateSrt(segments), generateVtt(segments)]) {
      expect(out).toContain('a\nb');
      expect(out).toContain('next');
      // Two cue blocks, so the structure survived.
      expect(out.split(' --> ')).toHaveLength(3);
    }
  });
});

describe('multi-line cues', () => {
  it('round-trip through SRT as a two-line body', () => {
    const srt = generateSrt([{ start: 0, end: 1.5, text: 'line one\nline two' }]);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,500\nline one\nline two\n');
  });

  it('round-trip through VTT as a two-line body', () => {
    const vtt = generateVtt([{ start: 0, end: 1.5, text: 'line one\nline two' }]);
    expect(vtt).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nline one\nline two\n');
  });

  it('keep the speaker prefix on the first line only', () => {
    const srt = generateSrt([
      { start: 0, end: 1, text: 'line one\nline two', speakerLabel: 'Speaker 1' },
    ]);
    expect(srt).toContain('[Speaker 1] line one\nline two');
  });

  it('survive a JSON patch with their newline escaped', () => {
    const original = JSON.stringify({ segments: [{ start: 0, end: 1, text: 'old' }] });
    const patched = patchJsonWithEdits(original, [{ text: 'line one\nline two' }]);
    expect(JSON.parse(patched).segments[0].text).toBe('line one\nline two');
    expect(patched).toContain('\\n');
  });
});

describe('the editor no longer flattens cue text', () => {
  // Source-scraping, because subtitle-editor.js is a renderer ES module
  // that touches `document` at import time and vitest runs without jsdom.
  // These three lines were what destroyed a cue's line break: the load
  // normaliser (which also flattened `original`, so Revert could not put
  // one back), the Enter block, and the input-handler collapse.
  const editor = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../src/renderer/components/subtitle-editor.js'),
    'utf-8',
  );

  it('does not collapse newlines into spaces anywhere', () => {
    expect(editor).not.toMatch(/replace\(\/\\s\*\\n\+\\s\*\/g, ' '\)/);
  });

  it('still defers to the IME on Enter', () => {
    // Removing this guard makes it impossible to type Chinese.
    expect(editor).toContain('e.isComposing || e.keyCode === 229');
  });

  it('gates Enter on the configured line count rather than blocking it', () => {
    expect(editor).toContain("textArea.value.split('\\n').length >= state.maxLines");
    expect(editor).toContain('transcript:editor.toast.lineLimit');
  });

  it('preserves the caret when it rewrites the value', () => {
    // The old handler reassigned .value unconditionally, which sent the
    // caret to the end on every multi-line paste.
    expect(editor).toContain('setSelectionRange(caret, caret)');
  });
});
