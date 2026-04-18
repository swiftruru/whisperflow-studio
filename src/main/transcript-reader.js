'use strict';

/**
 * Transcript reader for the post-run preview card.
 *
 * Prefers the raw segment JSON when present (`<basename>.json`) — it
 * carries precise segment objects from whisperflow directly.  Falls
 * back to parsing `<basename>.srt` so we still show something when
 * write_json is disabled in the user's config.
 */

const fs = require('fs');
const path = require('path');

function parseSrtTime(stamp) {
  // "00:01:23,456"  →  83.456  seconds
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(stamp.trim());
  if (!match) return 0;
  const [, hh, mm, ss, ms] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
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
    const text = lines.slice(idx + 1).join('\n');
    if (!text) continue;
    segments.push({ start, end, text });
  }
  return segments;
}

function readFromJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const segments = Array.isArray(parsed) ? parsed : (parsed.segments || []);
  return segments
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: (s.text || '').trim(),
    }))
    .filter((s) => s.text);
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
 * otherwise we look next to the media file.  Returns `{ segments, source }`
 * where `source` is the absolute path that was read.
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
      return { segments: readFromJson(jsonPath), source: jsonPath };
    } catch (_) { /* fall through */ }
  }
  if (fs.existsSync(srtPath)) {
    return { segments: readFromSrt(srtPath), source: srtPath };
  }
  if (fs.existsSync(vttPath)) {
    return { segments: readFromVtt(vttPath), source: vttPath };
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
  readTranscriptForMedia,
  hasTranscriptForMedia,
};
