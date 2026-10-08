'use strict';

// Pure helpers behind the "label speaker names" dialog.
//
// Deliberately free of DOM and i18n so the rules here can be unit-tested
// directly, and so the editor and the preview share one implementation
// rather than growing two that drift.

/** Seconds a cue covers, never negative. */
function duration(seg) {
  return Math.max(0, (Number(seg.end) || 0) - (Number(seg.start) || 0));
}

/**
 * Overlay the user's names onto the labels diarization produced.
 *
 * The sparse-labelling rule is diarization's answer and renaming does not
 * get a vote in it: `speakerLabel` is set on the first cue of each turn
 * and absent on every cue in between, which is the only thing keeping a
 * `[Speaker 1] ` prefix off all 938 lines of a long transcript.  So a
 * name is substituted only into a cue that already carries a label —
 * never used to give one to a cue that does not.
 *
 * Returns the same array when there is nothing to apply, and otherwise
 * copies only the segments it actually changes, so the editor's draft
 * identity stays as stable as it can.
 */
export function applySpeakerNames(segments, names) {
  if (!Array.isArray(segments) || !names) return segments;
  return segments.map((seg) => {
    if (!seg || !seg.speakerLabel) return seg;
    const name = names[seg.speaker];
    return name ? { ...seg, speakerLabel: name } : seg;
  });
}

/**
 * Pick the excerpts that best identify a speaker.
 *
 * Longest first, because a long turn is what lets someone recognise a
 * voice — a one-word "對。" identifies nobody.  Then back into timeline
 * order so a card reads like the recording rather than like a ranking.
 * Ties break on start time, so the choice is deterministic.
 */
function pickExcerpts(cues, count) {
  return [...cues]
    .sort((a, b) => (duration(b) - duration(a)) || (a.start - b.start))
    .slice(0, Math.max(0, count))
    .sort((a, b) => a.start - b.start)
    .map((seg) => ({ start: seg.start, end: seg.end, text: seg.text }));
}

/**
 * Group segments by speaker for the naming dialog.
 *
 * Ordered by speaker index, which is first-appearance order: diarization
 * renumbers its clusters by when each voice is first heard, so index
 * order is the order the user met these people in.
 *
 * Segments with no integer speaker are ignored rather than collected
 * into an "unknown" bucket — they occur when diarization was off or
 * found no turns at all, and in both cases there is nobody to name.
 */
export function summarizeSpeakers(segments, { excerpts = 3 } = {}) {
  if (!Array.isArray(segments)) return [];
  const groups = new Map();

  segments.forEach((seg) => {
    if (!seg || !Number.isInteger(seg.speaker)) return;
    let group = groups.get(seg.speaker);
    if (!group) {
      group = { speaker: seg.speaker, totalSeconds: 0, label: null, cues: [] };
      groups.set(seg.speaker, group);
    }
    group.totalSeconds += duration(seg);
    // The first label this speaker carries is the one diarization wrote
    // for their first turn, which is what the dialog shows as the
    // placeholder when the user has not named them yet.
    if (!group.label && seg.speakerLabel) group.label = seg.speakerLabel;
    group.cues.push(seg);
  });

  return [...groups.values()]
    .sort((a, b) => a.speaker - b.speaker)
    .map((group) => ({
      speaker: group.speaker,
      label: group.label,
      totalSeconds: group.totalSeconds,
      cueCount: group.cues.length,
      excerpts: pickExcerpts(group.cues, excerpts),
    }));
}

/**
 * "4m 56s", "1h 03m", "18s" — the compact form the dialog shows beside a
 * speaker and beside each excerpt.  Untranslated by design: these are
 * numbers with unit letters, and both locales of this app already print
 * durations this way.
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

/** `00:01:07` — the excerpt time code, matching the editor's own column. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const secs = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}:${secs}`;
}

/**
 * Turn the dialog's inputs into the map that goes to disk: blank fields
 * dropped, whitespace trimmed, and a name identical to the label
 * diarization already produced dropped too — storing "Speaker 2" as a
 * chosen name would survive a later change to the label template and
 * quietly override it.
 */
export function collectNames(entries) {
  const out = {};
  entries.forEach(({ speaker, name, label }) => {
    if (!Number.isInteger(speaker) || typeof name !== 'string') return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === label) return;
    out[String(speaker)] = trimmed;
  });
  return out;
}

/**
 * Do two name maps say the same thing?
 *
 * Key order is not significant and null, undefined and {} all mean "no
 * names", so a JSON.stringify comparison would report spurious
 * differences.  The editor's unsaved-changes flag turns on this, and
 * getting it wrong in the "same" direction loses a rename silently.
 */
export function namesEqual(a, b) {
  const left = a || {};
  const right = b || {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
}
