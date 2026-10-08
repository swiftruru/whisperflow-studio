'use strict';

/**
 * Transcript reader for the post-run preview card.
 *
 * Prefers the raw segment JSON when present (`<basename>.json`) — it
 * carries precise segment objects from whisperflow directly.  Falls
 * back to parsing `<basename>.srt` so we still show something when
 * write_json is disabled in the user's config.
 *
 * The SRT/VTT fallback deliberately does NOT try to recover speaker
 * labels from the cue text.  Whisper emits bracketed content of its own
 * ([Music], [音樂]), so `[...]` at the start of a line is ambiguous by
 * construction; the prefix simply displays as part of the text.
 */

const fs = require('fs');
const path = require('path');

function parseSrtTime(stamp) {
  // "00:01:23,456" -> 83.456, and "01:23.456" -> 83.456.
  //
  // The hours block is optional because WebVTT makes it optional and our
  // own writer omits it: writers.py:96 emits `HH:` only when the cue is
  // an hour in, or when always_include_hours is set, which only SRT sets.
  // So a recording whose speech ends before the hour mark produces a VTT
  // in which EVERY cue is short-form.  Requiring the hours block parsed
  // all of them to 0, and because a failed parse returned 0 rather than
  // signalling, the preview showed a full transcript with every timestamp
  // reading 00:00:00 and nothing anywhere said why.
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(stamp.trim());
  if (!match) return null;
  const [, hh, mm, ss, ms] = match;
  // Milliseconds are positional: ".5" is 500 ms, not 5 ms.
  return Number(hh || 0) * 3600
    + Number(mm) * 60
    + Number(ss)
    + Number(ms.padEnd(3, '0')) / 1000;
}

function parseSrt(source) {
  const blocks = source.replace(/\r\n/g, '\n').split(/\n\s*\n+/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    let idx = 0;
    // First line may be index or (rare) directly timing — skip a numeric-only
    // first line if present.
    if (/^\d+$/.test(lines[0])) idx = 1;
    const timing = lines[idx];
    const arrow = timing.indexOf('-->');
    if (arrow === -1) continue;
    const start = parseSrtTime(timing.slice(0, arrow));
    const end = parseSrtTime(timing.slice(arrow + 3));
    // A cue whose timing does not parse is dropped rather than handed
    // over as 0 -> 0.  Keeping it would put a cue at the start of the
    // timeline that belongs somewhere else, and saving from the editor
    // would then write that back over the file.
    if (start === null || end === null) continue;
    const text = lines.slice(idx + 1).join('\n');
    if (!text) continue;
    segments.push({ start, end, text });
  }
  return segments;
}

/**
 * Pull the per-speaker names out of a transcript's top-level `speakers`
 * block, sanitising as we go.
 *
 * The block is written by the editor, not by Python, and it lives at the
 * top level for two reasons: `patchJsonWithEdits` re-serialises the whole
 * document so an unknown top-level key survives every save untouched,
 * and segmentation's cue builder is an explicit whitelist that would
 * silently drop a new per-segment key.  It mirrors the shape of
 * `segmentation`, including the `version` marker.
 *
 * Keys are the speaker integers as JSON stringifies them.  Anything that
 * is not a run of digits mapped to a non-blank string is dropped rather
 * than trusted: this file is on the user's disk and they can edit it.
 *
 * Returns null when there is nothing usable, so callers can treat
 * "absent" and "empty" identically — which is what makes re-transcribing
 * discard the names for free, since Python rewrites the whole JSON from a
 * result dict that has no `speakers` key.
 */
function normalizeSpeakerNames(names) {
  if (!names || typeof names !== 'object' || Array.isArray(names)) return null;
  const out = {};
  for (const [key, value] of Object.entries(names)) {
    if (!/^\d+$/.test(key)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return Object.keys(out).length ? out : null;
}

function readSpeakerNames(parsed) {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
  const block = parsed.speakers;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  return normalizeSpeakerNames(block.names);
}

function readFromJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const segments = Array.isArray(parsed) ? parsed : (parsed.segments || []);
  const mapped = segments
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: (s.text || '').trim(),
      // Speaker fields ride alongside the text rather than inside it: the
      // JSON keeps a clean `text`, the preview renders the label as a
      // separate chip, and the editor can regenerate SRT/VTT/TXT with the
      // same `[Speaker 1] ` prefix the Python writers produce.  Null when
      // the file predates diarization or it was switched off.
      speaker: Number.isInteger(s.speaker) ? s.speaker : null,
      speakerLabel: typeof s.speaker_label === 'string' && s.speaker_label.trim()
        ? s.speaker_label
        : null,
    }))
    .filter((s) => s.text);
  return { segments: mapped, speakers: readSpeakerNames(parsed) };
}

function readFromSrt(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseSrt(raw);
}

// WebVTT is structurally compatible with our SRT parser — both use
// `HH:MM:SS.sss --> HH:MM:SS.sss\ntext` blocks separated by blank
// lines.  `parseSrt`'s timestamp regex already accepts either `,` or
// `.` as the fractional separator, and the leading `WEBVTT` header
// block is silently dropped because it has no `-->` arrow.  So we
// reuse the same parser here instead of writing a second one.
function readFromVtt(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseSrt(raw);
}

/**
 * Read transcript segments from the file produced for `mediaPath`.
 *
 * `outputDir` overrides the directory (when the user sets output_dir);
 * otherwise we look next to the media file.  Returns
 * `{ segments, source, speakers }` where `source` is the absolute path
 * that was read and `speakers` is the per-speaker name map, or null when
 * the file has none (or is an SRT/VTT, which cannot carry one).
 */
function readTranscriptForMedia(mediaPath, outputDir) {
  if (!mediaPath) throw new Error('mediaPath required');
  const baseDir = outputDir && outputDir.trim() ? outputDir : path.dirname(mediaPath);
  const baseName = path.basename(mediaPath, path.extname(mediaPath));

  const jsonPath = path.join(baseDir, `${baseName}.json`);
  const srtPath = path.join(baseDir, `${baseName}.srt`);
  const vttPath = path.join(baseDir, `${baseName}.vtt`);

  // Preference order: JSON (richest, per-segment logprob etc.) → SRT →
  // VTT.  This lets the preview work as long as ANY one of the three
  // timed-subtitle outputs is enabled in Settings.  If the user turns
  // off all three, we fall through to the not-found error — at that
  // point there really is nothing to preview.
  if (fs.existsSync(jsonPath)) {
    try {
      const { segments, speakers } = readFromJson(jsonPath);
      return { segments, source: jsonPath, speakers };
    } catch (_) { /* fall through */ }
  }
  // The SRT/VTT fallbacks carry no speaker data at all -- parseSrt yields
  // {start, end, text} and the label stays embedded in the cue text -- so
  // `speakers` is null and the naming UI has nothing to group by.
  if (fs.existsSync(srtPath)) {
    return { segments: readFromSrt(srtPath), source: srtPath, speakers: null };
  }
  if (fs.existsSync(vttPath)) {
    return { segments: readFromVtt(vttPath), source: vttPath, speakers: null };
  }
  const err = new Error(`No transcript found beside ${mediaPath}`);
  err.code = 'TRANSCRIPT_NOT_FOUND';
  throw err;
}

/**
 * Cheap existence check — just stat the expected `.json` / `.srt` paths
 * without actually parsing them.  Used by the renderer on boot to hide
 * the preview eye button for history rows whose transcript has been
 * manually deleted from disk.
 */
function hasTranscriptForMedia(mediaPath, outputDir) {
  if (!mediaPath) return false;
  const baseDir = outputDir && outputDir.trim() ? outputDir : path.dirname(mediaPath);
  const baseName = path.basename(mediaPath, path.extname(mediaPath));
  // Mirror readTranscriptForMedia's preference order — preview is
  // supported as long as any one of json / srt / vtt is on disk.
  return fs.existsSync(path.join(baseDir, `${baseName}.json`))
    || fs.existsSync(path.join(baseDir, `${baseName}.srt`))
    || fs.existsSync(path.join(baseDir, `${baseName}.vtt`));
}

module.exports = {
  parseSrt,
  normalizeSpeakerNames,
  readSpeakerNames,
  readTranscriptForMedia,
  hasTranscriptForMedia,
};
