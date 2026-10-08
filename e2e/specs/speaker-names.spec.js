'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('../fixtures/electron-app');

// Naming the speakers a diarized run found, through the real UI.
//
// The unit suites already cover the data path and the dialog's own
// behaviour in happy-dom.  What only a launched app can show is the
// wiring between them: that the toolbar button exists and is enabled,
// that clicking it opens a dialog built from the transcript on disk,
// and that confirming reaches the chips and then the files.

const BASE = 'talk';

// Two speakers, four turns.  speaker_label on the first segment of each
// turn only -- the shape Python writes, and the thing a rename must not
// disturb.
const SEGMENTS = [
  { start: 0, end: 10, text: 'a long opening from the first voice', speaker: 0, speaker_label: 'Speaker 1' },
  { start: 10, end: 12, text: 'still the first voice', speaker: 0 },
  { start: 12, end: 30, text: 'the second voice at some length', speaker: 1, speaker_label: 'Speaker 2' },
  { start: 30, end: 31, text: 'briefly', speaker: 1 },
  { start: 31, end: 36, text: 'and back to the first', speaker: 0, speaker_label: 'Speaker 1' },
];

function seedTranscript(dir) {
  fs.writeFileSync(path.join(dir, `${BASE}.mkv`), 'not really a video');
  fs.writeFileSync(
    path.join(dir, `${BASE}.json`),
    JSON.stringify({ segments: SEGMENTS, text: 'x', language: 'en' }, null, 2),
  );
  const srt = SEGMENTS.map((s, i) => {
    const stamp = (v) => new Date(v * 1000).toISOString().substr(11, 12).replace('.', ',');
    const prefix = s.speaker_label ? `[${s.speaker_label}] ` : '';
    return `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${prefix}${s.text}\n`;
  }).join('\n');
  fs.writeFileSync(path.join(dir, `${BASE}.srt`), srt);
  return path.join(dir, `${BASE}.mkv`);
}

/** Put one row in the history so the editor can be opened the way a user does. */
async function openEditorFromHistory(app, mediaPath) {
  fs.writeFileSync(
    path.join(app.userDataDir, 'history.json'),
    JSON.stringify([{
      fileName: path.basename(mediaPath),
      filePath: mediaPath,
      success: true,
      timestamp: new Date('2026-10-08T12:00:00Z').toISOString(),
    }]),
  );
  await app.window.reload();
  await app.window.waitForSelector('#tab-main.active', { timeout: 10_000 });
  await app.window.locator('.history-action-edit').first().click();
  await expect(app.window.locator('#subtitle-editor-modal')).toBeVisible();
}

test.describe('speaker names — naming a diarized transcript', () => {
  let workDir;
  let mediaPath;

  test.beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfs-speakers-'));
    mediaPath = seedTranscript(workDir);
  });

  test.afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('names a speaker and the name reaches the chips and the files', async ({ app }, testInfo) => {
    const { window } = app;
    await openEditorFromHistory(app, mediaPath);

    // The chips start as the labels diarization produced, once per turn.
    await expect(window.locator('.subtitle-editor-speaker-chip')).toHaveCount(3);
    await expect(window.locator('.subtitle-editor-speaker-chip').first()).toHaveText('Speaker 1');

    const button = window.locator('#btn-subtitle-editor-speakers');
    await expect(button).toBeVisible();
    // setEnabled() removes the attribute when enabled rather than setting
    // it to "false" -- see the long rationale above it in subtitle-editor.js.
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await button.click();

    // One card per speaker, each with the label as placeholder, that
    // speaker's total talk time, and their longest turns.
    const dialog = window.locator('.speaker-names-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.speaker-names-input')).toHaveCount(2);
    await expect(dialog.locator('.speaker-names-input').first())
      .toHaveAttribute('placeholder', 'Speaker 1');
    await expect(dialog).toContainText('Total 17s');   // speaker 0: 10 + 2 + 5
    await expect(dialog).toContainText('Total 19s');   // speaker 1: 18 + 1
    await expect(dialog).toContainText('a long opening from the first voice');

    await testInfo.attach('dialog', {
      body: await dialog.screenshot(), contentType: 'image/png',
    });

    await dialog.locator('.speaker-names-input').first().fill('Sandy');
    await dialog.locator('.speaker-names-input').nth(1).fill('LINE BANK');
    await dialog.locator('.btn-primary').click();
    await expect(dialog).toBeHidden();

    // The chips update, and there are still three of them: renaming must
    // not hand a label to the cues in between.
    await expect(window.locator('.subtitle-editor-speaker-chip')).toHaveCount(3);
    await expect(window.locator('.subtitle-editor-speaker-chip').first()).toHaveText('Sandy');
    await expect(window.locator('.subtitle-editor-speaker-chip').nth(1)).toHaveText('LINE BANK');

    await testInfo.attach('editor-after-naming', {
      body: await window.locator('#subtitle-editor-modal').screenshot(),
      contentType: 'image/png',
    });

    // Renaming alone counts as an unsaved change.
    const save = window.locator('#btn-subtitle-editor-save');
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');
    await save.click();
    await expect(save).toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 });

    const srt = fs.readFileSync(path.join(workDir, `${BASE}.srt`), 'utf-8');
    expect(srt).toContain('[Sandy] a long opening');
    expect(srt).toContain('[LINE BANK] the second voice');
    expect(srt).not.toContain('[Speaker ');
    expect((srt.match(/\[(Sandy|LINE BANK)\] /g) || [])).toHaveLength(3);

    const json = JSON.parse(fs.readFileSync(path.join(workDir, `${BASE}.json`), 'utf-8'));
    expect(json.speakers).toEqual({ version: 1, names: { 0: 'Sandy', 1: 'LINE BANK' } });
    // The per-segment labels stay as diarization wrote them.
    expect(json.segments[0].speaker_label).toBe('Speaker 1');
  });

  test('the names come back after closing and reopening the editor', async ({ app }) => {
    const { window } = app;
    await openEditorFromHistory(app, mediaPath);

    await window.locator('#btn-subtitle-editor-speakers').click();
    await window.locator('.speaker-names-input').first().fill('Sandy');
    await window.locator('.speaker-names-dialog .btn-primary').click();
    await expect(window.locator('.subtitle-editor-speaker-chip').first()).toHaveText('Sandy');
    await window.locator('#btn-subtitle-editor-save').click();
    await expect(window.locator('#btn-subtitle-editor-save'))
      .toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 });

    await window.locator('#btn-subtitle-editor-close').click();
    await expect(window.locator('#subtitle-editor-modal')).toBeHidden();

    // This is the regression the whole feature turns on: the editor reads
    // the JSON first, so before the top-level block existed the name was
    // gone by now.
    await window.locator('.history-action-edit').first().click();
    await expect(window.locator('.subtitle-editor-speaker-chip').first()).toHaveText('Sandy');
  });

  test('Escape closes the dialog without closing the editor behind it', async ({ app }) => {
    const { window } = app;
    await openEditorFromHistory(app, mediaPath);

    await window.locator('#btn-subtitle-editor-speakers').click();
    await expect(window.locator('.speaker-names-dialog')).toBeVisible();

    await window.keyboard.press('Escape');

    await expect(window.locator('.speaker-names-dialog')).toHaveCount(0);
    await expect(window.locator('#subtitle-editor-modal')).toBeVisible();
  });

  test('the button is disabled when the transcript has no speakers', async ({ app }) => {
    const { window } = app;
    fs.writeFileSync(
      path.join(workDir, `${BASE}.json`),
      JSON.stringify({
        segments: [{ start: 0, end: 1, text: 'no speaker data here' }],
        text: 'x', language: 'en',
      }, null, 2),
    );
    await openEditorFromHistory(app, mediaPath);

    const button = window.locator('#btn-subtitle-editor-speakers');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAttribute('title', /no speaker information/i);
  });
});
