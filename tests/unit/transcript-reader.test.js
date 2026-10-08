import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import transcriptReader from '../../src/main/transcript-reader.js';

const { parseSrt, readTranscriptForMedia, hasTranscriptForMedia } = transcriptReader;

let workDir;
let mediaPath;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-transcript-'));
  mediaPath = path.join(workDir, 'clip.mp4');
  fs.writeFileSync(mediaPath, 'not really a video');
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const writeSidecar = (ext, body) => fs.writeFileSync(path.join(workDir, `clip.${ext}`), body);

describe('parseSrt', () => {
  it('parses numbered blocks into seconds', () => {
    expect(parseSrt(
      '1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n'
      + '2\n00:01:23,456 --> 00:01:24,000\nSecond cue\n',
    )).toEqual([
      { start: 0, end: 1.5, text: 'Hello world' },
      { start: 83.456, end: 84, text: 'Second cue' },
    ]);
  });

  it('accepts a block with no index line', () => {
    expect(parseSrt('00:00:02,000 --> 00:00:03,000\nno index')).toEqual([
      { start: 2, end: 3, text: 'no index' },
    ]);
  });

  it('normalises CRLF and joins multi-line cue text', () => {
    expect(parseSrt('1\r\n00:00:00,000 --> 00:00:01,000\r\nline one\r\nline two\r\n')).toEqual([
      { start: 0, end: 1, text: 'line one\nline two' },
    ]);
  });

  it('drops blocks with no arrow and blocks with no text', () => {
    // This is also what makes the parser safe to reuse for VTT: the
    // WEBVTT header block has no arrow, so it falls out.
    expect(parseSrt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n')).toEqual([
      { start: 0, end: 1, text: 'hi' },
    ]);
    expect(parseSrt('1\n00:00:00,000 --> 00:00:01,000\n')).toEqual([]);
  });

  it('keeps speaker prefixes in the cue text rather than parsing them out', () => {
    // Deliberate: Whisper emits bracketed content of its own ([Music],
    // [音樂]), so reverse-parsing a speaker out of subtitle text would
    // misread those as speakers.  The prefix just displays as text.
    expect(parseSrt('1\n00:00:00,000 --> 00:00:01,000\n[Speaker 1] hi\n')).toEqual([
      { start: 0, end: 1, text: '[Speaker 1] hi' },
    ]);
  });
});

describe('readTranscriptForMedia', () => {
  it('prefers the JSON sidecar', () => {
    writeSidecar('json', JSON.stringify({
      segments: [{ start: 0, end: 1, text: ' from json ' }],
    }));
    writeSidecar('srt', '1\n00:00:00,000 --> 00:00:01,000\nfrom srt\n');

    const result = readTranscriptForMedia(mediaPath, '');
    expect(result.source).toBe(path.join(workDir, 'clip.json'));
    expect(result.segments).toEqual([
      { start: 0, end: 1, text: 'from json', speaker: null, speakerLabel: null },
    ]);
  });

  it('accepts a bare top-level array in the JSON', () => {
    writeSidecar('json', JSON.stringify([{ start: 1, end: 2, text: 'bare' }]));
    expect(readTranscriptForMedia(mediaPath, '').segments).toEqual([
      { start: 1, end: 2, text: 'bare', speaker: null, speakerLabel: null },
    ]);
  });

  it('drops empty-text segments, which makes JSON and array indices diverge', () => {
    writeSidecar('json', JSON.stringify({
      segments: [
        { start: 0, end: 1, text: 'first' },
        { start: 1, end: 2, text: '   ' },
        { start: 2, end: 3, text: 'third' },
      ],
    }));
    // Pinned because subtitle-writer.js's patchJsonWithEdits matches by
    // array index: a dropped segment shifts every later edit onto the
    // wrong JSON object.
    expect(readTranscriptForMedia(mediaPath, '').segments.map((s) => s.text))
      .toEqual(['first', 'third']);
  });

  it('falls back to SRT, then VTT, when there is no JSON', () => {
    writeSidecar('srt', '1\n00:00:00,000 --> 00:00:01,000\nfrom srt\n');
    expect(readTranscriptForMedia(mediaPath, '').segments[0].text).toBe('from srt');

    fs.rmSync(path.join(workDir, 'clip.srt'));
    writeSidecar('vtt', 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfrom vtt\n');
    expect(readTranscriptForMedia(mediaPath, '').segments[0].text).toBe('from vtt');
  });

  it('falls back to SRT when the JSON is unparseable', () => {
    writeSidecar('json', '{ this is not json');
    writeSidecar('srt', '1\n00:00:00,000 --> 00:00:01,000\nfrom srt\n');
    expect(readTranscriptForMedia(mediaPath, '').segments[0].text).toBe('from srt');
  });

  it('honours an explicit output directory', () => {
    const outDir = path.join(workDir, 'out');
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'clip.json'), JSON.stringify([{ start: 0, end: 1, text: 'elsewhere' }]));
    expect(readTranscriptForMedia(mediaPath, outDir).segments[0].text).toBe('elsewhere');
  });

  it('throws TRANSCRIPT_NOT_FOUND when nothing is beside the media', () => {
    expect(() => readTranscriptForMedia(mediaPath, '')).toThrowError(
      expect.objectContaining({ code: 'TRANSCRIPT_NOT_FOUND' }),
    );
  });

  it('requires a media path', () => {
    expect(() => readTranscriptForMedia('', '')).toThrow(/mediaPath required/);
  });
});

describe('hasTranscriptForMedia', () => {
  it('is true when any of the three sidecars exists', () => {
    expect(hasTranscriptForMedia(mediaPath, '')).toBe(false);
    writeSidecar('vtt', 'WEBVTT\n');
    expect(hasTranscriptForMedia(mediaPath, '')).toBe(true);
  });
});

describe('speaker labels', () => {
  it('carries speaker and speakerLabel out of the JSON', () => {
    writeSidecar('json', JSON.stringify({
      segments: [
        { start: 0, end: 1, text: 'hello', speaker: 0, speaker_label: 'Speaker 1' },
        { start: 1, end: 2, text: 'hi', speaker: 1, speaker_label: '講者 2' },
      ],
    }));
    expect(readTranscriptForMedia(mediaPath, '').segments).toEqual([
      { start: 0, end: 1, text: 'hello', speaker: 0, speakerLabel: 'Speaker 1' },
      { start: 1, end: 2, text: 'hi', speaker: 1, speakerLabel: '講者 2' },
    ]);
  });

  it('normalises missing or blank speaker fields to null', () => {
    writeSidecar('json', JSON.stringify({
      segments: [
        { start: 0, end: 1, text: 'a' },
        { start: 1, end: 2, text: 'b', speaker: 'nonsense', speaker_label: '   ' },
      ],
    }));
    const segments = readTranscriptForMedia(mediaPath, '').segments;
    expect(segments[0]).toMatchObject({ speaker: null, speakerLabel: null });
    expect(segments[1]).toMatchObject({ speaker: null, speakerLabel: null });
  });

  it('keeps speaker 0 rather than treating it as absent', () => {
    // The first speaker is index 0, which is falsy — a truthiness check
    // here would silently drop every "Speaker 1" label.
    writeSidecar('json', JSON.stringify([{ start: 0, end: 1, text: 'a', speaker: 0, speaker_label: 'Speaker 1' }]));
    expect(readTranscriptForMedia(mediaPath, '').segments[0].speaker).toBe(0);
  });

  it('does not parse speaker labels back out of an SRT fallback', () => {
    // Whisper emits [Music] / [音樂] of its own, so recovering a speaker
    // from the text would misread those as speakers.  The prefix stays in
    // the text and no speakerLabel is invented.
    writeSidecar('srt', '1\n00:00:00,000 --> 00:00:01,000\n[Speaker 1] hi\n');
    const segments = readTranscriptForMedia(mediaPath, '').segments;
    expect(segments[0].text).toBe('[Speaker 1] hi');
    expect(segments[0].speakerLabel).toBeUndefined();
  });
});

describe('speaker names', () => {
  // Per-speaker names live in a top-level `speakers` block rather than on
  // the segments, because segmentation's cue builder is an explicit
  // whitelist that drops unknown per-segment keys, while this function
  // and patchJsonWithEdits both carry unknown top-level keys through.
  const withSpeakers = (speakers) => JSON.stringify({
    segments: [
      { start: 0, end: 1, text: 'hello', speaker: 0, speaker_label: 'Speaker 1' },
      { start: 1, end: 2, text: 'there', speaker: 1, speaker_label: 'Speaker 2' },
    ],
    ...(speakers === undefined ? {} : { speakers }),
  });

  it('reads the name map out of the top-level block', () => {
    writeSidecar('json', withSpeakers({ version: 1, names: { 0: 'Sandy', 1: 'LINE BANK' } }));
    expect(readTranscriptForMedia(mediaPath).speakers)
      .toEqual({ 0: 'Sandy', 1: 'LINE BANK' });
  });

  it('is null when the transcript has no block', () => {
    writeSidecar('json', withSpeakers(undefined));
    expect(readTranscriptForMedia(mediaPath).speakers).toBeNull();
  });

  it('treats an empty name map as no names at all', () => {
    // So callers can test one thing. It is also what re-transcribing
    // produces, since Python rewrites the document without the key.
    writeSidecar('json', withSpeakers({ version: 1, names: {} }));
    expect(readTranscriptForMedia(mediaPath).speakers).toBeNull();
  });

  it('drops entries that are not a speaker index mapped to a name', () => {
    // This file is on the user's disk and they can edit it.
    writeSidecar('json', withSpeakers({
      version: 1,
      names: { 0: 'Sandy', '-1': 'negative', 'x': 'not an index', 2: 42, 3: '   ', 4: 'Kept' },
    }));
    expect(readTranscriptForMedia(mediaPath).speakers).toEqual({ 0: 'Sandy', 4: 'Kept' });
  });

  it('trims the names it keeps', () => {
    writeSidecar('json', withSpeakers({ version: 1, names: { 0: '  Sandy  ' } }));
    expect(readTranscriptForMedia(mediaPath).speakers).toEqual({ 0: 'Sandy' });
  });

  it.each([
    ['an array', []],
    ['a string', 'Sandy'],
    ['a number', 7],
    ['null', null],
  ])('survives a block that is %s', (_label, block) => {
    writeSidecar('json', withSpeakers(block));
    expect(readTranscriptForMedia(mediaPath).speakers).toBeNull();
  });

  it('is null for the SRT fallback, which cannot carry one', () => {
    // parseSrt yields {start, end, text} and leaves "[Speaker 1] " inside
    // the cue text, so there is nothing to group by.
    writeSidecar('srt', '1\n00:00:00,000 --> 00:00:01,000\n[Speaker 1] hello\n');
    const result = readTranscriptForMedia(mediaPath);
    expect(result.source.endsWith('.srt')).toBe(true);
    expect(result.speakers).toBeNull();
  });
});

describe('the transcript:read IPC handler forwards everything', () => {
  // A source-reading contract test, in the style of stage-plumbing.test.js.
  //
  // The regression: the handler listed its reply fields by hand, so when
  // `speakers` was added to readTranscriptForMedia it was silently
  // dropped on the way to the renderer.  Nothing failed -- the names were
  // written to disk correctly and simply never came back, which looked
  // exactly like "the feature does not work" with every unit test green,
  // because they all call the reader directly and never cross IPC.
  const handlerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'ipc-handlers.js'),
    'utf-8',
  );

  it('replies by spreading the reader result, not by naming fields', () => {
    const block = handlerSource.slice(handlerSource.indexOf("ipcMain.handle('transcript:read'"));
    const reply = block.slice(0, block.indexOf('} catch'));
    expect(reply).toContain('...result');
    expect(reply).not.toMatch(/segments:\s*result\.segments/);
  });

  it('forwards every field the reader actually returns', () => {
    // Belt and braces: if the reader grows another field tomorrow, this
    // fails unless the handler is still spreading.
    writeSidecar('json', JSON.stringify({
      segments: [{ start: 0, end: 1, text: 'hi', speaker: 0, speaker_label: 'Speaker 1' }],
      speakers: { version: 1, names: { 0: 'Sandy' } },
    }));
    const produced = Object.keys(readTranscriptForMedia(mediaPath)).sort();
    expect(produced).toEqual(['segments', 'source', 'speakers']);
  });
});

describe('parseSrt — WebVTT timestamps without an hours block', () => {
  // The regression, found by a user: the preview showed all 715 cues of a
  // real transcript with every timestamp reading 00:00:00 and a total
  // length of 00:00.  WebVTT makes the hours block optional and our own
  // writer omits it (writers.py:96 adds `HH:` only past the hour, or when
  // always_include_hours is set, which only SRT sets), so a recording
  // whose speech ends before the hour mark produces a VTT in which EVERY
  // cue is short-form.  parseSrtTime required the block and returned 0 on
  // a miss, which is indistinguishable from a cue that really does start
  // at zero -- so nothing failed, it just silently lied.

  it('parses a short-form cue', () => {
    expect(parseSrt('WEBVTT\n\n04:09.018 --> 04:11.738\nMicrophone\n'))
      .toEqual([{ start: 249.018, end: 251.738, text: 'Microphone' }]);
  });

  it('still parses the long form, with either separator', () => {
    expect(parseSrt('1\n00:01:23,456 --> 00:01:24,000\nSRT style\n'))
      .toEqual([{ start: 83.456, end: 84, text: 'SRT style' }]);
    expect(parseSrt('WEBVTT\n\n01:04:16.100 --> 01:04:17.000\nPast the hour\n'))
      .toEqual([{ start: 3856.1, end: 3857, text: 'Past the hour' }]);
  });

  it('handles a file that switches form at the hour mark', () => {
    // Which is what our writer produces for anything over an hour.
    const cues = parseSrt(
      'WEBVTT\n\n59:59.000 --> 01:00:01.000\nacross\n\n'
      + '01:00:01.000 --> 01:00:02.000\nafter\n',
    );
    expect(cues.map((c) => [c.start, c.end]))
      .toEqual([[3599, 3601], [3601, 3602]]);
  });

  it('reads milliseconds positionally', () => {
    // ".5" is 500 ms. Treating the digits as a plain number made a cue
    // land 495 ms early.
    expect(parseSrt('WEBVTT\n\n00:01.5 --> 00:02.25\nshort fraction\n')[0])
      .toEqual({ start: 1.5, end: 2.25, text: 'short fraction' });
  });

  it('accepts an hours field longer than two digits', () => {
    expect(parseSrt('WEBVTT\n\n100:00:00.000 --> 100:00:01.000\nlong haul\n')[0].start)
      .toBe(360000);
  });

  it('drops a cue whose timing cannot be parsed, rather than placing it at zero', () => {
    // Keeping it would put a cue at the start of the timeline that belongs
    // somewhere else — and the editor would write that back over the file.
    const cues = parseSrt(
      'WEBVTT\n\nnonsense --> garbage\nbad\n\n00:05.000 --> 00:06.000\ngood\n',
    );
    expect(cues).toEqual([{ start: 5, end: 6, text: 'good' }]);
  });

  it('keeps a cue that genuinely starts at zero', () => {
    // The other half: dropping unparseable cues must not drop real ones.
    expect(parseSrt('WEBVTT\n\n00:00.000 --> 00:01.000\nfrom the top\n'))
      .toEqual([{ start: 0, end: 1, text: 'from the top' }]);
  });

  it('parses a whole short-form VTT the way the preview would read it', () => {
    writeSidecar('vtt', 'WEBVTT\n\n'
      + '04:09.018 --> 04:11.738\n[Speaker 1] Microphone\n\n'
      + '58:42.510 --> 58:44.510\n[Speaker 3] the end\n');
    const { segments } = readTranscriptForMedia(mediaPath);
    expect(segments).toHaveLength(2);
    expect(segments[0].start).toBeCloseTo(249.018, 3);
    expect(segments[1].end).toBeCloseTo(3524.51, 3);
  });
});
