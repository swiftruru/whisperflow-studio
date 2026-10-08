// @vitest-environment happy-dom
//
// Opted in per file rather than globally: every other suite here covers
// main-process CommonJS and runs faster without a DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/lib/i18n.js', () => ({
  // The real t() returns '' for a missing key rather than the key
  // itself, so a typo renders blank instead of failing loudly.  Here we
  // return the defaultValue the caller supplied, which is what makes a
  // missing defaultValue visible in these assertions -- and interpolate
  // {{name}} the way i18next does, so the assertions also check that the
  // right parameters were handed over.
  t: (_key, opts = {}) => String(opts.defaultValue ?? '')
    .replace(/\{\{(\w+)\}\}/g, (match, name) => (
      name in opts ? String(opts[name]) : match
    )),
}));

const { openSpeakerNamesDialog } = await import(
  '../../src/renderer/components/speaker-names-dialog.js'
);

const SEGMENTS = [
  { start: 0, end: 10, text: 'a long opening', speaker: 0, speakerLabel: 'Speaker 1' },
  { start: 10, end: 12, text: 'still me', speaker: 0, speakerLabel: null },
  { start: 12, end: 30, text: 'the other person', speaker: 1, speakerLabel: 'Speaker 2' },
];

const overlay = () => document.querySelector('.modal-overlay');
const inputs = () => [...document.querySelectorAll('.speaker-names-input')];
const press = (key, target) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (target || document.body).dispatchEvent(event);
  return event;
};

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('openSpeakerNamesDialog', () => {
  it('renders one card per speaker, in first-appearance order', () => {
    openSpeakerNamesDialog({ segments: SEGMENTS, names: null });
    expect(inputs()).toHaveLength(2);
    expect(inputs().map((i) => i.placeholder)).toEqual(['Speaker 1', 'Speaker 2']);
  });

  it('pre-fills the names already in force', () => {
    openSpeakerNamesDialog({ segments: SEGMENTS, names: { 0: 'Sandy' } });
    expect(inputs().map((i) => i.value)).toEqual(['Sandy', '']);
  });

  it('shows each speaker total and their excerpts', () => {
    openSpeakerNamesDialog({ segments: SEGMENTS, names: null });
    const text = document.querySelector('.speaker-names-dialog').textContent;
    expect(text).toContain('Total 12s');   // speaker 0: 10 + 2
    expect(text).toContain('Total 18s');   // speaker 1
    expect(text).toContain('00:00:00 - 00:00:10');
    expect(text).toContain('a long opening');
  });

  it('resolves with the names when confirmed', async () => {
    const done = openSpeakerNamesDialog({ segments: SEGMENTS, names: null });
    inputs()[0].value = 'Sandy';
    inputs()[1].value = '  LINE BANK  ';
    document.querySelector('.btn-primary').click();
    await expect(done).resolves.toEqual({ 0: 'Sandy', 1: 'LINE BANK' });
    expect(overlay()).toBeNull();
  });

  it('resolves with an empty map when every name is cleared', async () => {
    // Distinct from cancelling: this is an instruction to remove them.
    const done = openSpeakerNamesDialog({ segments: SEGMENTS, names: { 0: 'Sandy' } });
    inputs()[0].value = '';
    document.querySelector('.btn-primary').click();
    await expect(done).resolves.toEqual({});
  });

  it.each([
    ['cancel', () => document.querySelector('.btn-secondary').click()],
    ['the close button', () => document.querySelector('.speaker-names-close').click()],
    ['a backdrop click', () => overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }))],
    ['Escape', () => press('Escape')],
  ])('resolves null on %s, changing nothing', async (_label, act) => {
    const done = openSpeakerNamesDialog({ segments: SEGMENTS, names: { 0: 'Sandy' } });
    inputs()[0].value = 'typed but abandoned';
    act();
    await expect(done).resolves.toBeNull();
    expect(overlay()).toBeNull();
  });

  it('stops Escape from also reaching the editor underneath', async () => {
    // The hazard: subtitle-editor.js listens for Escape on document in
    // the BUBBLE phase and gates only on its own modal being visible --
    // which it still is, behind this dialog.  Without stopPropagation
    // one keypress cancels here and closes the editor as well.
    const editorHandler = vi.fn();
    document.addEventListener('keydown', editorHandler);          // bubble, like the editor's
    try {
      const done = openSpeakerNamesDialog({ segments: SEGMENTS, names: null });
      press('Escape');
      await done;
      expect(editorHandler).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', editorHandler);
    }
  });

  it('defers to the IME, so Enter can commit a Chinese candidate', async () => {
    // These fields exist to be typed into in Chinese; 注音 commits with
    // Enter, and submitting on that keypress would close the dialog
    // mid-word.
    //
    // Dispatched from the LAST field on purpose.  From any earlier one,
    // Enter merely advances, so the dialog stays open whether the guard
    // is there or not and the test proves nothing -- it passed against a
    // build with the guard deleted.
    const done = openSpeakerNamesDialog({ segments: SEGMENTS, names: null });
    const last = inputs()[inputs().length - 1];
    last.value = '張教授';
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    });
    Object.defineProperty(composing, 'isComposing', { value: true });
    last.dispatchEvent(composing);
    expect(overlay()).not.toBeNull();

    document.querySelector('.btn-secondary').click();
    await expect(done).resolves.toBeNull();
  });

  it('also honours keyCode 229, which some IMEs send instead', async () => {
    // Not redundant with isComposing: the pair is the convention used
    // throughout this editor (subtitle-editor.js does the same), because
    // not every IME sets isComposing on the committing keypress.
    const done = openSpeakerNamesDialog({ segments: SEGMENTS, names: null });
    const last = inputs()[inputs().length - 1];
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    });
    Object.defineProperty(composing, 'isComposing', { value: false });
    Object.defineProperty(composing, 'keyCode', { value: 229 });
    last.dispatchEvent(composing);
    expect(overlay()).not.toBeNull();

    document.querySelector('.btn-secondary').click();
    await expect(done).resolves.toBeNull();
  });

  it('submits on Enter from the last field once the IME is done', async () => {
    // The other half of the pair: the guard must not make Enter useless.
    const done = openSpeakerNamesDialog({ segments: SEGMENTS, names: null });
    const all = inputs();
    all[all.length - 1].value = '張教授';
    press('Enter', all[all.length - 1]);
    await expect(done).resolves.toEqual({ 1: '張教授' });
  });

  it('advances on Enter rather than submitting from the first field', async () => {
    // Submitting here would throw away the names not yet typed.
    const done = openSpeakerNamesDialog({ segments: SEGMENTS, names: null });
    inputs()[0].value = 'Sandy';
    press('Enter', inputs()[0]);
    expect(overlay()).not.toBeNull();
    expect(document.activeElement).toBe(inputs()[1]);

    inputs()[1].value = 'LINE BANK';
    press('Enter', inputs()[1]);
    await expect(done).resolves.toEqual({ 0: 'Sandy', 1: 'LINE BANK' });
  });

  it('removes its keydown listener once closed', async () => {
    // A leaked capture-phase listener would swallow Escape for the rest
    // of the session.
    const done = openSpeakerNamesDialog({ segments: SEGMENTS, names: null });
    document.querySelector('.btn-secondary').click();
    await done;

    const after = vi.fn();
    document.addEventListener('keydown', after);
    try {
      press('Escape');
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', after);
    }
  });

  it('renders nothing to name when the transcript has no speakers', () => {
    openSpeakerNamesDialog({
      segments: [{ start: 0, end: 1, text: 'x', speaker: null, speakerLabel: null }],
      names: null,
    });
    expect(inputs()).toHaveLength(0);
  });
});
