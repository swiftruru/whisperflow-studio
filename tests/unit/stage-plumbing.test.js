import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A stage name emitted by Python has to be wired up in five places before
 * it shows correctly, and every one of them fails *silently*: a missing
 * keyMap entry renders the chip as "Idle", a missing locale key renders an
 * empty string, a missing getStageProgress case leaves the bar wherever it
 * was.  This test reads the sources and checks all five, so adding a stage
 * and forgetting one is a test failure rather than a UI mystery.
 */

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf-8');
const readJson = (relative) => JSON.parse(read(relative));

// STAGE_X = "..." out of python/whisperflow/events.py
const PYTHON_STAGES = [...read('python/whisperflow/events.py')
  .matchAll(/^STAGE_[A-Z_]+ = "([a-z-]+)"$/gm)]
  .map((match) => match[1]);

// The keyMap in queue-panel.js's stageLabel(), as `'stage': 'progressKey'`.
const CHIP_KEY_MAP = Object.fromEntries(
  [...read('src/renderer/components/queue-panel.js')
    .matchAll(/^\s*'([a-z-]+)':\s*'([A-Za-z]+)',$/gm)]
    .map((match) => [match[1], match[2]]),
);

const CONSOLE_LABELS = read('src/renderer/components/console-log.js')
  .match(/const STAGE_LABELS = \{[\s\S]*?\};/)[0];

const STAGE_PROGRESS = read('src/main/queue-manager.js')
  .match(/function getStageProgress\(stage\) \{[\s\S]*?\n\}/)[0];

describe('runner stage plumbing', () => {
  it('found the stage constants to check', () => {
    expect(PYTHON_STAGES).toContain('diarizing');
    expect(PYTHON_STAGES).toContain('segmenting');
    expect(PYTHON_STAGES).toContain('loading-vad');
    expect(PYTHON_STAGES.length).toBeGreaterThanOrEqual(9);
  });

  it.each(PYTHON_STAGES)('%s has a stage-chip label in both locales', (stage) => {
    const progressKey = CHIP_KEY_MAP[stage];
    expect(progressKey, `queue-panel.js keyMap is missing '${stage}'`).toBeDefined();
    for (const locale of ['en', 'zh-TW']) {
      const labels = readJson(`locales/${locale}/progress.json`).stage;
      expect(labels[progressKey], `${locale}/progress.json is missing stage.${progressKey}`)
        .toBeTruthy();
    }
  });

  it.each(PYTHON_STAGES)('%s has a Console label', (stage) => {
    expect(CONSOLE_LABELS).toContain(`'${stage}'`);
  });

  it.each([
    'preparing',
    'loading-model',
    'loading-vad',
    'transcribing',
    'diarizing',
    'segmenting',
    'writing-subtitle',
  ])(
    '%s has a progress fallback for events that carry no explicit value',
    (stage) => {
      expect(STAGE_PROGRESS).toContain(`case '${stage}':`);
    },
  );

  it('has the diarization stage messages in both locales', () => {
    for (const locale of ['en', 'zh-TW']) {
      const stage = readJson(`locales/${locale}/events.json`).stage;
      expect(stage.diarizing).toBeTruthy();
      expect(stage.preparingDiarization).toBeTruthy();
      // The cold-start message has to name the download size.
      expect(stage.downloadingDiarizationModels).toContain('{{size}}');
    }
  });
});

describe('diarization error codes', () => {
  const codes = ['DIARIZATION_DEPENDENCY_MISSING', 'DIARIZATION_MODEL_DOWNLOAD_FAILED'];
  const catalog = read('src/main/error-catalog.js');
  const dispatch = read('src/main/ipc-handlers.js');

  it.each(codes)('%s is registered and dispatched', (code) => {
    expect(catalog).toContain(`${code}: '${code}'`);
    expect(dispatch).toContain(`ERROR_CODES.${code}`);
  });

  it.each(codes)('%s has title and message in both locales', (code) => {
    for (const locale of ['en', 'zh-TW']) {
      const entry = readJson(`locales/${locale}/errors.json`)[code];
      expect(entry, `${locale}/errors.json is missing ${code}`).toBeDefined();
      expect(entry.title).toBeTruthy();
      expect(entry.message).toBeTruthy();
    }
  });

  it('maps every reason Python can raise to a code', () => {
    // These strings are the `reason` values in diarization.py and
    // models/diarization_models.py.  A reason with no branch here lands on
    // the generic "transcription failed" banner.
    const reasons = [
      ...[...read('python/whisperflow/models/diarization_models.py')
        .matchAll(/^REASON_[A-Z_]+ = "([a-z_]+)"$/gm)].map((m) => m[1]),
      read('python/whisperflow/diarization.py').match(/reason = "([a-z_]+)"/)[1],
    ];
    expect(reasons.length).toBe(4);
    for (const reason of reasons) {
      expect(dispatch, `ipc-handlers.js does not dispatch on '${reason}'`).toContain(`${reason}:`);
    }
  });

  it('offers a remedy that is not "retry" for the missing-dependency case', () => {
    // Retrying a run cannot install a pip package, so that banner has to
    // offer the environment update instead.
    expect(dispatch).toMatch(
      /diarization_dependency_missing:[\s\S]*?suggestedAction: 'update-venv-requirements'/,
    );
    expect(read('src/renderer/components/error-actions.js'))
      .toContain("case 'update-venv-requirements':");
    for (const locale of ['en', 'zh-TW']) {
      expect(readJson(`locales/${locale}/errors.json`).actions.updateEnvironment).toBeTruthy();
    }
  });
});
