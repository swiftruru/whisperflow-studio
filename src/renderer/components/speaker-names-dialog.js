'use strict';

import { t } from '../lib/i18n.js';
import {
  collectNames,
  formatClock,
  formatDuration,
  summarizeSpeakers,
} from '../lib/speaker-names.js';

// "Label speaker names" — give each voice diarization found a real name.
//
// Built with createElement and appended to document.body rather than
// declared in index.html, following promptForName() in
// profile-switcher.js.  Three reasons it has to be this one and not the
// static-markup dialogs: the number of speaker cards is not known when
// the markup is written, so a static shell would still need a renderer
// for its contents and we would pay for both; promptForName is the only
// existing modal that pairs an editable <input> with cancel/confirm; and
// appending last puts this overlay after #subtitle-editor-modal in DOM
// order, so it paints on top without touching z-index (both are 200).

const EXCERPTS_PER_SPEAKER = 3;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderExcerpt(excerpt) {
  const row = el('div', 'speaker-names-excerpt');

  const head = el('div', 'speaker-names-excerpt-head');
  head.appendChild(el(
    'span',
    'speaker-names-excerpt-time',
    `${formatClock(excerpt.start)} - ${formatClock(excerpt.end)}`,
  ));
  head.appendChild(el(
    'span',
    'speaker-names-excerpt-duration',
    formatDuration(excerpt.end - excerpt.start),
  ));
  row.appendChild(head);

  // Flattened: a cue may hold a line break of its own and this is a
  // two-line preview, not a subtitle.
  row.appendChild(el('p', 'speaker-names-excerpt-text', String(excerpt.text || '').replace(/\s*\n\s*/g, ' ')));
  return row;
}

function renderCard(summary, names) {
  const card = el('div', 'speaker-names-card');

  const input = el('input', 'speaker-names-input');
  input.type = 'text';
  input.spellcheck = false;
  // The placeholder is the label diarization produced, so an untouched
  // field shows exactly what the subtitles say today.
  input.placeholder = summary.label || '';
  input.value = names?.[summary.speaker] ?? '';
  input.setAttribute(
    'aria-label',
    t('transcript:editor.speakers.nameFor', {
      label: summary.label || String(summary.speaker + 1),
      defaultValue: 'Name for {{label}}',
    }),
  );
  card.appendChild(input);

  card.appendChild(el(
    'p',
    'speaker-names-total',
    t('transcript:editor.speakers.total', {
      duration: formatDuration(summary.totalSeconds),
      defaultValue: 'Total {{duration}}',
    }),
  ));

  const list = el('div', 'speaker-names-excerpts');
  summary.excerpts.forEach((excerpt) => list.appendChild(renderExcerpt(excerpt)));
  card.appendChild(list);

  if (summary.cueCount > summary.excerpts.length) {
    card.appendChild(el('p', 'speaker-names-more', '······'));
  }

  return { card, input, summary };
}

/**
 * Open the dialog.  Resolves to the name map to persist, or null if the
 * user cancelled — which is the signal to change nothing at all, not to
 * clear the names.
 *
 * `segments` are the editor's live draft and `names` the map currently in
 * force.  Neither is mutated.
 */
export function openSpeakerNamesDialog({ segments, names }) {
  return new Promise((resolve) => {
    const summaries = summarizeSpeakers(segments, { excerpts: EXCERPTS_PER_SPEAKER });

    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal speaker-names-dialog');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const header = el('div', 'speaker-names-header');
    header.appendChild(el('h2', null, t('transcript:editor.speakers.title', {
      defaultValue: 'Label speaker names',
    })));
    const close = el('button', 'speaker-names-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', t('transcript:editor.actions.close', {
      defaultValue: 'Close',
    }));
    header.appendChild(close);
    modal.appendChild(header);

    const body = el('div', 'speaker-names-body');
    const rendered = summaries.map((summary) => renderCard(summary, names));
    rendered.forEach(({ card }) => body.appendChild(card));
    modal.appendChild(body);

    modal.appendChild(el('p', 'speaker-names-footnote', t(
      'transcript:editor.speakers.footnote',
      { defaultValue: 'Speaker names are updated throughout this file.' },
    )));

    const actions = el('div', 'confirm-dialog-actions');
    const cancel = el('button', 'btn-secondary confirm-dialog-btn', t(
      'transcript:editor.actions.cancel', { defaultValue: 'Cancel' },
    ));
    cancel.type = 'button';
    const confirm = el('button', 'btn-primary confirm-dialog-btn', t(
      'dialogs:confirm.confirmLabel', { defaultValue: 'Confirm' },
    ));
    confirm.type = 'button';
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    modal.appendChild(actions);

    overlay.appendChild(modal);

    function cleanup(value) {
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(value);
    }

    function submit() {
      cleanup(collectNames(rendered.map(({ input, summary }) => ({
        speaker: summary.speaker,
        name: input.value,
        label: summary.label,
      }))));
    }

    function onKeyDown(e) {
      // Defer to the IME: Enter is how 注音/拼音 commits a candidate, and
      // these fields exist to be typed into in Chinese.
      if (e.isComposing || e.keyCode === 229) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        // The subtitle editor listens for Escape on document in the
        // bubble phase and gates only on its own modal being visible --
        // which it still is, underneath this one.  Without this the key
        // would cancel here and close the editor behind it.
        e.stopPropagation();
        cleanup(null);
        return;
      }

      if (e.key === 'Enter') {
        // With several fields, Enter submitting from the first one would
        // throw away the names the user had not typed yet.  It advances
        // instead, and only submits from the last field.
        const index = rendered.findIndex(({ input }) => input === e.target);
        if (index >= 0 && index < rendered.length - 1) {
          e.preventDefault();
          rendered[index + 1].input.focus();
          return;
        }
        e.preventDefault();
        submit();
      }
    }

    close.addEventListener('click', () => cleanup(null));
    cancel.addEventListener('click', () => cleanup(null));
    confirm.addEventListener('click', submit);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
    });
    document.addEventListener('keydown', onKeyDown, true);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => rendered[0]?.input.focus());
  });
}
