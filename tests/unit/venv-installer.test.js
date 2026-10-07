import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import venvInstaller from '../../src/main/venv-installer.js';

const {
  INSTALLED_MARKER,
  REQUIREMENTS_MARKER,
  getVenvState,
  readInstalledRequirementsHash,
  requirementsHash,
} = venvInstaller;

let venvRoot;
let requirementsPath;

beforeEach(() => {
  venvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-venv-'));
  requirementsPath = path.join(venvRoot, 'requirements.txt');
  fs.writeFileSync(requirementsPath, 'faster-whisper>=0.10.0\nav<19\n');
});

afterEach(() => {
  fs.rmSync(venvRoot, { recursive: true, force: true });
});

const markInstalled = () =>
  fs.writeFileSync(path.join(venvRoot, INSTALLED_MARKER), new Date().toISOString());
const writeHash = (hash) =>
  fs.writeFileSync(path.join(venvRoot, REQUIREMENTS_MARKER), hash);

describe('requirementsHash', () => {
  it('hashes the file contents', () => {
    const hash = requirementsHash(requirementsPath);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(requirementsHash(requirementsPath)).toBe(hash);
  });

  it('changes when the file changes at all, comments included', () => {
    const before = requirementsHash(requirementsPath);
    fs.appendFileSync(requirementsPath, '# just a comment\n');
    expect(requirementsHash(requirementsPath)).not.toBe(before);
  });

  it('returns null for an unreadable file rather than throwing', () => {
    expect(requirementsHash(path.join(venvRoot, 'nope.txt'))).toBeNull();
  });
});

describe('readInstalledRequirementsHash', () => {
  it('returns null when the marker is absent', () => {
    expect(readInstalledRequirementsHash(venvRoot)).toBeNull();
  });

  it('trims the stored value', () => {
    writeHash('  abc123\n');
    expect(readInstalledRequirementsHash(venvRoot)).toBe('abc123');
  });

  it('treats an empty marker as absent', () => {
    writeHash('   ');
    expect(readInstalledRequirementsHash(venvRoot)).toBeNull();
  });
});

describe('getVenvState', () => {
  it('reports a pre-1.17 venv as stale, not uninitialized', () => {
    // This is the whole point of using a second marker file: an existing
    // user's venv has `.whisperflow-installed` but no requirements hash,
    // which has to read as "needs updating" with no migration step — and
    // crucially must NOT change what isVenvInitialized() means, because
    // preflight-checker.js and the run gate in ipc-handlers.js both use it.
    markInstalled();
    const state = getVenvState({ venvRoot, requirementsPath });
    expect(state.upToDate).toBe(false);
    expect(state.installedHash).toBeNull();
    expect(state.expectedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a matching hash as up to date', () => {
    markInstalled();
    writeHash(requirementsHash(requirementsPath));
    expect(getVenvState({ venvRoot, requirementsPath }).upToDate).toBe(true);
  });

  it('goes stale again when requirements.txt is edited', () => {
    markInstalled();
    writeHash(requirementsHash(requirementsPath));
    fs.appendFileSync(requirementsPath, 'sherpa-onnx>=1.13.8,<2\n');
    expect(getVenvState({ venvRoot, requirementsPath }).upToDate).toBe(false);
  });

  it('is not up to date when requirements.txt cannot be read', () => {
    // Guards against a missing requirements file hashing to null on both
    // sides and so comparing equal.
    markInstalled();
    writeHash('whatever');
    const state = getVenvState({ venvRoot, requirementsPath: path.join(venvRoot, 'gone.txt') });
    expect(state.expectedHash).toBeNull();
    expect(state.upToDate).toBe(false);
  });

  it('is not up to date for a venv that does not exist yet', () => {
    const state = getVenvState({ venvRoot, requirementsPath });
    expect(state.initialized).toBe(false);
    expect(state.upToDate).toBe(false);
  });
});
