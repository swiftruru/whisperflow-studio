'use strict';

/**
 * Diagnostics collector for the About → Report-an-issue flow.
 *
 * Produces a plain-object snapshot the renderer can either dump to the
 * clipboard or save as a .txt, so users can paste it into a GitHub
 * issue without hand-collecting OS / venv / GPU / config info.
 *
 * Privacy notes
 * -------------
 * - Absolute paths under the user's home directory are rewritten to `~`
 *   so usernames don't leak.
 * - config.json and settings.json are included (they're user-owned and
 *   intentionally visible in the app), but `media_file_path`-style
 *   transient fields are redacted to just their basename.
 * - GPU probe is opt-in via venv availability — we don't attempt to
 *   install anything; if the venv isn't ready we skip the probe.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { spawn } = require('child_process');
const { resolveBundledPython } = require('./path-resolver');
const { isVenvInitialized } = require('./venv-installer');

function redactHome(value) {
  if (typeof value !== 'string' || !value) return value;
  const home = os.homedir();
  if (!home) return value;
  if (value.startsWith(home)) return '~' + value.slice(home.length);
  return value;
}

function redactObjectPaths(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactHome(obj);
  if (Array.isArray(obj)) return obj.map(redactObjectPaths);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'media_file_path' && typeof v === 'string' && v) {
        out[k] = path.basename(v);
      } else {
        out[k] = redactObjectPaths(v);
      }
    }
    return out;
  }
  return obj;
}

async function runGpuProbe(venvPython) {
  if (!venvPython) return { status: 'skipped', reason: 'no-venv' };
  const script = [
    'import json, sys',
    'out = {"cuda": False, "mps": False, "device_name": None, "error": None}',
    'try:',
    '    import torch',
    '    out["cuda"] = bool(torch.cuda.is_available())',
    '    if hasattr(torch.backends, "mps"):',
    '        out["mps"] = bool(torch.backends.mps.is_available())',
    '    if out["cuda"]:',
    '        out["device_name"] = torch.cuda.get_device_name(0)',
    'except Exception as e:',
    '    out["error"] = f"{type(e).__name__}: {e}"',
    'sys.stdout.write(json.dumps(out))',
  ].join('\n');

  return new Promise((resolve) => {
    const child = spawn(venvPython, ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      resolve({ status: 'timeout' });
    }, 5000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve({ status: 'error', error: stderr || 'spawn failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve({ status: 'error', exitCode: code, stderr: stderr.slice(0, 500) });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({ status: 'ok', ...parsed });
      } catch (err) {
        resolve({ status: 'parse-error', raw: stdout.slice(0, 500) });
      }
    });
  });
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { _readError: err.message };
  }
}

function folderSize(dir) {
  let total = 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = folderSize(full);
        total += sub.total;
        count += sub.count;
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
          count += 1;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return { total, count };
}

async function collectDiagnostics({
  recentLogLines = [],
  electronAppRoot,
  venvRoot,
  configPath,
  getLocalSettings,
  modelsDir,
}) {
  const venvPython = venvRoot ? resolveBundledPython(venvRoot) : null;
  const venvReady = Boolean(venvPython) && venvRoot && isVenvInitialized(venvRoot);

  const gpu = venvReady ? await runGpuProbe(venvPython) : { status: 'skipped', reason: 'venv-not-initialized' };

  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();

  const diagnostics = {
    app: {
      name: app.getName(),
      version: app.getVersion(),
      locale: app.getLocale(),
      isPackaged: app.isPackaged,
    },
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      v8: process.versions.v8,
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      osVersion: (typeof os.version === 'function') ? os.version() : undefined,
      cpuModel: cpus[0]?.model || 'unknown',
      cpuCount: cpus.length,
      totalMemoryGB: +(totalMem / (1024 ** 3)).toFixed(2),
    },
    venv: {
      root: redactHome(venvRoot || ''),
      initialized: venvReady,
      pythonPath: venvPython ? redactHome(venvPython) : null,
    },
    gpuProbe: gpu,
    models: (() => {
      if (!modelsDir) return { status: 'unknown' };
      const stat = folderSize(modelsDir);
      return {
        dir: redactHome(modelsDir),
        totalSizeGB: +(stat.total / (1024 ** 3)).toFixed(2),
        fileCount: stat.count,
      };
    })(),
    config: (() => {
      if (!configPath) return {};
      return redactObjectPaths(safeReadJson(configPath));
    })(),
    settings: (() => {
      try {
        const raw = typeof getLocalSettings === 'function' ? getLocalSettings() : null;
        return redactObjectPaths(raw || {});
      } catch (err) {
        return { _readError: err.message };
      }
    })(),
    recentLog: Array.isArray(recentLogLines) ? recentLogLines.slice(-500) : [],
    collectedAt: new Date().toISOString(),
  };

  return diagnostics;
}

function formatDiagnosticsAsText(d) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  push('=== WhisperFlow Studio diagnostics ===');
  push(`Collected at: ${d.collectedAt}`);
  push('');
  push('# App');
  push(`  version: ${d.app?.version}`);
  push(`  locale: ${d.app?.locale}`);
  push(`  packaged: ${d.app?.isPackaged}`);
  push('');
  push('# Runtime');
  push(`  electron: ${d.runtime?.electron}`);
  push(`  node:     ${d.runtime?.node}`);
  push(`  chrome:   ${d.runtime?.chrome}`);
  push('');
  push('# System');
  push(`  platform: ${d.system?.platform} (${d.system?.arch})`);
  push(`  os:       ${d.system?.osVersion || d.system?.osRelease}`);
  push(`  cpu:      ${d.system?.cpuModel} x${d.system?.cpuCount}`);
  push(`  memory:   ${d.system?.totalMemoryGB} GB`);
  push('');
  push('# Bundled venv');
  push(`  root:        ${d.venv?.root}`);
  push(`  initialized: ${d.venv?.initialized}`);
  push(`  python:      ${d.venv?.pythonPath}`);
  push('');
  push('# GPU probe');
  const gpu = d.gpuProbe || {};
  push(`  status: ${gpu.status}`);
  if (gpu.status === 'ok') {
    push(`  cuda:   ${gpu.cuda}`);
    push(`  mps:    ${gpu.mps}`);
    if (gpu.device_name) push(`  device: ${gpu.device_name}`);
  } else if (gpu.reason) {
    push(`  reason: ${gpu.reason}`);
  } else if (gpu.error) {
    push(`  error: ${gpu.error}`);
  }
  push('');
  push('# Models');
  const m = d.models || {};
  push(`  dir:        ${m.dir}`);
  push(`  total size: ${m.totalSizeGB} GB (${m.fileCount} files)`);
  push('');
  push('# Config (redacted)');
  push(JSON.stringify(d.config, null, 2));
  push('');
  push('# Settings (redacted)');
  push(JSON.stringify(d.settings, null, 2));
  push('');
  push('# Recent log (last ' + (d.recentLog?.length || 0) + ' lines)');
  if (Array.isArray(d.recentLog)) {
    for (const line of d.recentLog) push(line);
  }
  return lines.join('\n');
}

module.exports = {
  collectDiagnostics,
  formatDiagnosticsAsText,
};
