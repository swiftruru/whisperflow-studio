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
    expect(result.segments).toEqual([{ start: 0, end: 1, text: 'from json' }]);
  });

  it('accepts a bare top-level array in the JSON', () => {
    writeSidecar('json', JSON.stringify([{ start: 1, end: 2, text: 'bare' }]));
    expect(readTranscriptForMedia(mediaPath, '').segments).toEqual([
      { start: 1, end: 2, text: 'bare' },
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
