'use strict';

/**
 * Subtitle writer — used by the in-app editor to push text-only
 * edits back into whichever subtitle files the user currently has
 * enabled in Settings (write_srt / write_vtt / write_txt / write_json).
 *
 * Timestamps are intentionally read-only in the editor — this module
 * only ever updates segment `text`.  Start/end come straight from
 * whatever was on disk at load time, so we can't accidentally shift
 * the timeline.
 *
 * Backups land in the OS tmp dir (not next to the source) so the
 * user's media folder doesn't accumulate `.bak` files.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Rendered in front of the first line of a cue whose segment carries a
 * speaker label.
 *
 * KEEP IN SYNC with SPEAKER_PREFIX_FORMAT in
 * python/whisperflow/subtitles/writers.py.  Python writes the files
 * originally and this module regenerates them from the user's edits, so a
 * mismatch would silently rewrite every cue on the first save.  Pinned on
 * both sides: tests/unit/subtitle-writer.test.js here,
 * test_writers.py::test_speaker_prefix_format_constant_is_stable there.
 */
const SPEAKER_PREFIX_FORMAT = '[{label}] ';

/**
 * Silence that starts a new paragraph in the TXT transcript.
 *
 * KEEP IN SYNC with TXT_PARAGRAPH_GAP in
 * python/whisperflow/subtitles/writers.py.  Python writes the TXT first
 * and this module regenerates it from the user's edits, so a mismatch
 * would silently re-paragraph the whole file on the first save.  Pinned
 * from both sides: subtitle-writer.test.js reads the Python constant out
 * of its source, and both suites compare against the same hand-written
 * contract in tests/fixtures/txt-paragraphs.json.
 */
const TXT_PARAGRAPH_GAP = 2.0;

/**
 * Characters between which no space belongs when two cues are run
 * together into a paragraph.
 *
 * KEEP IN SYNC with _CJK_RANGES in python/whisperflow/subtitles/writers.py.
 * An explicit range set rather than each language's own "right" API
 * (`unicodedata.east_asian_width` there, `\p{Script=Han}` here), because
 * those two disagree on fullwidth Latin and several other edges, and the
 * two implementations have to agree exactly rather than approximately.
 */
const CJK_RANGES = [
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana and Katakana
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xff60], // Fullwidth forms
];

/** `"Speaker 1"` → `"[Speaker 1] "`; blank or missing → `''`. */
function formatSpeakerPrefix(label) {
  if (typeof label !== 'string') return '';
  const trimmed = label.trim();
  if (!trimmed) return '';
  return SPEAKER_PREFIX_FORMAT.replace('{label}', trimmed);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function formatSrtTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000);
  const rem1 = ms % 3_600_000;
  const m = Math.floor(rem1 / 60_000);
  const rem2 = rem1 % 60_000;
  const sec = Math.floor(rem2 / 1000);
  const millis = rem2 % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)},${pad3(millis)}`;
}

function formatVttTime(seconds) {
  return formatSrtTime(seconds).replace(',', '.');
}

// Prefix only a cue that has text, so a blank segment stays blank
// instead of becoming a bare label — matching Python's writers.
function cueText(seg) {
  // normalizeCueText here rather than only in the renderer: this is the
  // last point before bytes hit disk, so no save path can write a blank
  // line inside a cue whatever the UI did.  Uncapped on purpose -- the
  // line count is the editor's business, the blank line is everyone's.
  const text = normalizeCueText(String(seg.text ?? '').trim());
  if (!text.trim()) return '';
  return `${formatSpeakerPrefix(seg.speakerLabel)}${text}`;
}

function generateSrt(segments) {
  const out = [];
  segments.forEach((seg, idx) => {
    const text = cueText(seg);
    if (!text) return;
    out.push(String(idx + 1));
    out.push(`${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}`);
    out.push(text);
    out.push('');
  });
  return out.join('\n');
}

function generateVtt(segments) {
  const out = ['WEBVTT', ''];
  segments.forEach((seg) => {
    const text = cueText(seg);
    if (!text) return;
    // A plain text prefix, never a <v> tag: the app previews VTT through
    // its SRT parser, which would show the tag verbatim.
    out.push(`${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}`);
    out.push(text);
    out.push('');
  });
  return out.join('\n');
}

/**
 * Make a cue's text safe to write, whatever the editor handed over.
 *
 * Always collapses blank lines, which are a correctness problem rather
 * than a style one: a blank line terminates an SRT or WebVTT cue block,
 * so everything after it is silently dropped by any parser, this app's
 * own transcript-reader.js included.
 *
 * `maxLines` additionally caps the line count, folding the surplus into
 * the last allowed line rather than discarding it — losing the user's
 * words would be far worse than one long line.  It is left uncapped by
 * default, and supplied only by the editor, which knows the configured
 * limit: capping at a guessed 2 here would quietly destroy a legitimate
 * three-line cue for anyone who raised `subtitle_max_lines`.
 */
function normalizeCueText(text, maxLines = Infinity) {
  const limit = Math.max(1, Number(maxLines) || Infinity);
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  const kept = lines.filter((line, index) => line.trim() !== '' || index === 0);
  if (kept.length <= limit) return kept.join('\n');
  return [...kept.slice(0, limit - 1), kept.slice(limit - 1).join(' ')].join('\n');
}

function isCjk(char) {
  const code = char.codePointAt(0);
  return CJK_RANGES.some(([low, high]) => code >= low && code <= high);
}

/**
 * Only omitted when BOTH sides of the join are CJK: Chinese and Japanese
 * do not separate words, so a space there would be as wrong as dropping
 * one in English.  A Latin/CJK boundary keeps its space, which is what
 * Chinese typography does with embedded Latin anyway.
 */
function needsSpace(left, right) {
  if (!left || !right) return false;
  return !(isCjk(left[left.length - 1]) && isCjk(right[0]));
}

/**
 * Run consecutive cues by one speaker together into paragraphs.
 *
 * A paragraph break is a speaker change or more than TXT_PARAGRAPH_GAP
 * seconds of silence — structural rules only, no punctuation table and no
 * language knowledge, so this and Python's `_paragraphs` cannot drift
 * apart on the logic.  Each cue's own line break is flattened to a space:
 * TXT is prose, not subtitles.
 */
function buildParagraphs(segments) {
  const blocks = [];
  let buffer = '';
  let previous = null;

  for (const seg of segments) {
    const text = String(seg.text ?? '').split(/\s+/).filter(Boolean).join(' ');
    if (!text) continue;

    let startsParagraph;
    if (previous === null) {
      startsParagraph = true;
    } else {
      const gap = (Number(seg.start) || 0) - (Number(previous.end) || 0);
      startsParagraph = seg.speaker !== previous.speaker || gap > TXT_PARAGRAPH_GAP;
    }

    if (startsParagraph) {
      if (buffer) blocks.push(buffer);
      buffer = `${formatSpeakerPrefix(seg.speakerLabel)}${text}`;
    } else {
      buffer = `${buffer}${needsSpace(buffer, text) ? ' ' : ''}${text}`;
    }
    previous = seg;
  }

  if (buffer) blocks.push(buffer);
  return blocks;
}

function generateTxt(segments, { paragraphs = false } = {}) {
  if (!paragraphs) {
    // Match Python's write_txt: one stripped segment per line, trailing LF.
    return segments.map((seg) => cueText(seg)).join('\n') + '\n';
  }
  const blocks = buildParagraphs(segments);
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

/**
 * Patch the `text` field of each segment in an existing whisper JSON
 * result, preserving every other field (logprob, tokens, etc.) and
 * the top-level keys (language, duration, …).  Matches by array
 * index because the editor edits in-place — no reordering.
 */
function patchJsonWithEdits(originalJsonText, editedSegments) {
  const parsed = JSON.parse(originalJsonText);
  const segs = Array.isArray(parsed) ? parsed : parsed.segments;
  if (!Array.isArray(segs)) {
    const err = new Error('JSON has no segments array to patch');
    err.code = 'INVALID_JSON_SHAPE';
    throw err;
  }
  const n = Math.min(segs.length, editedSegments.length);
  for (let i = 0; i < n; i += 1) {
    segs[i].text = String(editedSegments[i].text ?? '');
  }
  return JSON.stringify(parsed, null, 2) + '\n';
}

function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    const err = new Error('No segments to write');
    err.code = 'EMPTY_SEGMENTS';
    throw err;
  }
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (typeof seg?.text !== 'string') {
      const err = new Error(`Segment ${i + 1} text must be a string`);
      err.code = 'INVALID_TEXT';
      throw err;
    }
  }
}

/** Ensure the per-run backup subdirectory exists and return its path. */
function ensureBackupDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(os.tmpdir(), 'whisperflow-studio-backups', stamp);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupFile(srcPath, backupDir) {
  const destName = path.basename(srcPath);
  const dest = path.join(backupDir, destName);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

function atomicWrite(filePath, contents) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, contents, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* tmp may be gone */ }
    throw err;
  }
}

/**
 * Rewrite every enabled subtitle file for a single media item with
 * updated segment text.  `formats` is a `{ srt, vtt, txt, json }`
 * object of booleans — sourced from config `write_*` so we match
 * exactly what the user has enabled in Settings.
 *
 * Returns a summary the renderer can show in a toast.
 */
function writeEditedSubtitles({ mediaPath, outputDir, segments, formats, paragraphs = false }) {
  if (!mediaPath) {
    const err = new Error('mediaPath required');
    err.code = 'NO_MEDIA_PATH';
    throw err;
  }
  validateSegments(segments);

  const baseDir = outputDir && String(outputDir).trim()
    ? String(outputDir).trim()
    : path.dirname(mediaPath);
  const baseName = path.basename(mediaPath, path.extname(mediaPath));

  const srtPath  = path.join(baseDir, `${baseName}.srt`);
  const vttPath  = path.join(baseDir, `${baseName}.vtt`);
  const txtPath  = path.join(baseDir, `${baseName}.txt`);
  const jsonPath = path.join(baseDir, `${baseName}.json`);

  const want = {
    srt:  !!(formats && formats.srt),
    vtt:  !!(formats && formats.vtt),
    txt:  !!(formats && formats.txt),
    json: !!(formats && formats.json),
  };

  const backupDir = ensureBackupDir();
  const written = [];
  const skipped = [];
  const backups = [];
  let totalBytes = 0;

  const handleFormat = (enabled, filePath, produce) => {
    if (!enabled) return;
    if (!fs.existsSync(filePath)) {
      // User enabled the format in Settings but hasn't run a
      // transcription that produced it yet — skip silently rather
      // than creating a freshly-formatted file that might conflict
      // with later overwrite-policy choices.
      skipped.push(path.basename(filePath));
      return;
    }
    try {
      backups.push(backupFile(filePath, backupDir));
      const contents = produce(filePath);
      atomicWrite(filePath, contents);
      totalBytes += Buffer.byteLength(contents, 'utf-8');
      written.push(path.basename(filePath));
    } catch (err) {
      err.code = err.code || 'WRITE_FAILED';
      err.partial = { written, backups, backupDir };
      throw err;
    }
  };

  handleFormat(want.srt,  srtPath,  () => generateSrt(segments));
  handleFormat(want.vtt,  vttPath,  () => generateVtt(segments));
  handleFormat(want.txt,  txtPath,  () => generateTxt(segments, { paragraphs }));
  handleFormat(want.json, jsonPath, (fp) => {
    const raw = fs.readFileSync(fp, 'utf-8');
    return patchJsonWithEdits(raw, segments);
  });

  return { written, skipped, backupDir, backups, bytes: totalBytes };
}

module.exports = {
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
  writeEditedSubtitles,
};
