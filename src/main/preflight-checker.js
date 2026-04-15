'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readConfig } = require('./config-manager');
const {
  resolveBundledPython,
  resolveSystemPython,
} = require('./path-resolver');
const { isVenvInitialized } = require('./venv-installer');
const { ERROR_CODES, createPreflightCheck } = require('./error-catalog');

function getPaths(electronAppRoot) {
  const pythonDir = path.join(electronAppRoot, 'python');
  return {
    pythonDir,
    configPath: path.join(pythonDir, 'config', 'config.json'),
    scanScriptPath: path.join(pythonDir, 'config_setting.py'),
    cliScriptPath: path.join(electronAppRoot, 'bridge', 'run_cli.py'),
    whisperflowPackagePath: path.join(pythonDir, 'whisperflow', '__init__.py'),
    requirementsPath: path.join(pythonDir, 'requirements.txt'),
  };
}

function isExistingDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch (_) {
    return false;
  }
}

function isExistingFile(targetPath) {
  try {
    return fs.statSync(targetPath).isFile();
  } catch (_) {
    return false;
  }
}

/**
 * Check that the ``ffmpeg`` and ``ffprobe`` binaries are reachable on the
 * augmented PATH that the packaged app inherits from the user's shell.
 *
 * Why this exists
 * ---------------
 * The whisperflow Python core uses ``ffmpeg-python`` to (a) probe the
 * duration of every input file and (b) decode chunks for VAD.  If
 * either binary is missing the very first call to ``ffmpeg.probe(...)``
 * inside ``audio/source.py`` raises ``FileNotFoundError`` with no
 * recovery path and the whole transcription job fails 5 seconds in.
 *
 * Surfacing it as a preflight check means the user sees the problem
 * the moment they open the app, with concrete install instructions,
 * instead of after they hit Run and watch the model load only to
 * crash before any subtitle is produced.
 */
function validateFfmpeg() {
  const missing = [];
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (!findExecutableOnPath(tool)) {
      missing.push(tool);
    }
  }

  if (missing.length === 0) {
    return createPreflightCheck({
      key: 'ffmpeg',
      status: 'ok',
      titleKey: 'preflight:checks.ffmpeg.okTitle',
      messageKey: 'preflight:checks.ffmpeg.okMessage',
    });
  }

  return createPreflightCheck({
    key: 'ffmpeg',
    code: ERROR_CODES.FFMPEG_NOT_FOUND,
    status: 'error',
    titleKey: 'preflight:checks.ffmpeg.missingTitle',
    titleParams: { tools: missing.join(' / ') },
    messageKey: 'preflight:checks.ffmpeg.missingMessage',
    // The renderer's preflight-panel picks this up and renders an
    // "安裝 ffmpeg" button that opens the themed install dialog.
    action: { type: 'install-ffmpeg', packageName: 'ffmpeg' },
  });
}

function findExecutableOnPath(name) {
  // On Windows, delegate to `where.exe` first.  winget installs
  // ffmpeg / ffprobe as App Execution Aliases in
  // %LOCALAPPDATA%\Microsoft\WinGet\Links\, which are APPEXECLINK
  // reparse points rather than real .exe files.  A manual PATH walk
  // backed by `fs.statSync(...).isFile()` returns false on these,
  // so preflight would say "not found" right after a successful
  // winget install.  `where` uses the OS's canonical resolver and
  // correctly follows the alias to the real target executable.
  // Falls back to the manual walk if `where` itself isn't reachable.
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where', [name], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString('utf-8').trim();
      if (out) {
        const first = out.split(/\r?\n/)[0]?.trim();
        if (first) return first;
      }
    } catch (_) {
      // fall through to the manual walk
    }
  }

  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.BAT;.CMD;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch (_) {
        // not found here, try next
      }
    }
  }
  return null;
}

function validateWhisperflowPackage(pythonDir) {
  const packageInit = path.join(pythonDir, 'whisperflow', '__init__.py');
  if (isExistingFile(packageInit)) {
    return createPreflightCheck({
      key: 'whisperflow_package',
      status: 'ok',
      titleKey: 'preflight:checks.whisperflowPackage.okTitle',
      messageKey: 'preflight:checks.whisperflowPackage.okMessage',
      detail: packageInit,
    });
  }

  return createPreflightCheck({
    key: 'whisperflow_package',
    code: ERROR_CODES.WHISPERFLOW_PACKAGE_MISSING,
    status: 'error',
    titleKey: 'preflight:checks.whisperflowPackage.errorTitle',
    messageKey: 'preflight:checks.whisperflowPackage.errorMessage',
    detail: packageInit,
  });
}

/**
 * Check the bundled venv's runtime state.  This is the System Check entry
 * shown in the preflight panel — it cares about whether `python -m
 * whisperflow.cli` can actually run, not about which system python was used
 * to bootstrap it.
 */
function validateBundledVenv({ venvRoot, configMetadataPath, userSettings }) {
  const venvPython = resolveBundledPython(venvRoot);

  if (venvPython && isVenvInitialized(venvRoot)) {
    return createPreflightCheck({
      key: 'bundled_python',
      status: 'ok',
      titleKey: 'preflight:checks.bundledPython.okTitle',
      messageKey: 'preflight:checks.bundledPython.okMessage',
      detail: venvPython,
    });
  }

  // The venv isn't there yet — make sure we at least have a system python
  // that can bootstrap it, otherwise this becomes an error instead of a
  // warning.
  const systemPython = resolveSystemPython(userSettings?.pythonPath, configMetadataPath);
  if (!systemPython) {
    return createPreflightCheck({
      key: 'bundled_python',
      code: ERROR_CODES.BUNDLED_PYTHON_NOT_FOUND,
      status: 'error',
      titleKey: 'preflight:checks.bundledPython.notFoundTitle',
      messageKey: 'preflight:checks.bundledPython.notFoundMessage',
      action: { type: 'open-settings', section: 'APP_SETTINGS', key: 'pythonPath' },
    });
  }

  return createPreflightCheck({
    key: 'bundled_python',
    code: ERROR_CODES.VENV_NOT_INITIALIZED,
    status: 'warning',
    titleKey: 'preflight:checks.bundledPython.venvMissingTitle',
    messageKey: 'preflight:checks.bundledPython.venvMissingMessage',
    detail: venvRoot,
    action: { type: 'initialize-venv' },
  });
}

/**
 * Validator for the `pythonPath` SETTING field specifically.  This is
 * different from `validateBundledVenv`: here the user is being asked to
 * pin a SYSTEM python interpreter (used only to bootstrap the venv on
 * first launch), not a path to the venv interpreter itself.
 *
 * Returns a `detail` of the resolved system python path so the form can
 * auto-fill it as a hint while leaving the underlying setting empty.
 */
function validateSystemPythonField(value, configMetadataPath) {
  const explicit = typeof value === 'string' ? value.trim() : '';

  if (explicit && !isExistingFile(explicit)) {
    return createPreflightCheck({
      key: 'pythonPath',
      code: ERROR_CODES.BUNDLED_PYTHON_NOT_FOUND,
      status: 'error',
      titleKey: 'preflight:checks.pythonPath.notExistTitle',
      messageKey: 'preflight:checks.pythonPath.notExistMessage',
      detail: explicit,
      action: { type: 'open-settings', section: 'APP_SETTINGS', key: 'pythonPath' },
    });
  }

  const resolved = resolveSystemPython(explicit, configMetadataPath);
  if (!resolved) {
    return createPreflightCheck({
      key: 'pythonPath',
      code: ERROR_CODES.BUNDLED_PYTHON_NOT_FOUND,
      status: 'error',
      titleKey: 'preflight:checks.pythonPath.notFoundTitle',
      messageKey: 'preflight:checks.pythonPath.notFoundMessage',
      action: { type: 'open-settings', section: 'APP_SETTINGS', key: 'pythonPath' },
    });
  }

  return createPreflightCheck({
    key: 'pythonPath',
    status: 'ok',
    titleKey: 'preflight:checks.pythonPath.okTitleDefault',
    messageKey: explicit
      ? 'preflight:checks.pythonPath.okMessageExplicit'
      : 'preflight:checks.pythonPath.okMessageAuto',
    detail: resolved,
  });
}

function validateMediaRootPath(value) {
  const mediaRootPath = typeof value === 'string' ? value.trim() : '';

  if (!mediaRootPath) {
    return createPreflightCheck({
      key: 'media_root_path',
      code: ERROR_CODES.MEDIA_ROOT_NOT_FOUND,
      status: 'error',
      titleKey: 'preflight:checks.mediaRootPath.unsetTitle',
      messageKey: 'preflight:checks.mediaRootPath.unsetMessage',
      action: { type: 'browse-media-root' },
    });
  }

  if (!isExistingDirectory(mediaRootPath)) {
    return createPreflightCheck({
      key: 'media_root_path',
      code: ERROR_CODES.MEDIA_ROOT_NOT_FOUND,
      status: 'error',
      titleKey: 'preflight:checks.mediaRootPath.missingTitle',
      messageKey: 'preflight:checks.mediaRootPath.missingMessage',
      detail: mediaRootPath,
      action: { type: 'browse-media-root' },
    });
  }

  return createPreflightCheck({
    key: 'media_root_path',
    status: 'ok',
    titleKey: 'preflight:checks.mediaRootPath.okTitle',
    messageKey: 'preflight:checks.mediaRootPath.okMessage',
    detail: mediaRootPath,
  });
}

function validateScriptPath(key, scriptPath) {
  const keyPrefix = key === 'scan_script' ? 'preflight:checks.scanScript' : 'preflight:checks.cliScript';
  if (isExistingFile(scriptPath)) {
    return createPreflightCheck({
      key,
      status: 'ok',
      titleKey: `${keyPrefix}.okTitle`,
      messageKey: `${keyPrefix}.okMessage`,
      detail: scriptPath,
    });
  }

  return createPreflightCheck({
    key,
    code: key === 'scan_script' ? ERROR_CODES.SCAN_SCRIPT_NOT_FOUND : ERROR_CODES.CLI_ENTRY_NOT_FOUND,
    status: 'error',
    titleKey: `${keyPrefix}.missingTitle`,
    messageKey: `${keyPrefix}.missingMessage`,
    detail: scriptPath,
  });
}

function validateSettingField({
  key,
  value,
  configMetadataPath,
}) {
  switch (key) {
    case 'media_root_path':
      return validateMediaRootPath(value);
    case 'pythonPath':
      // The setting is a SYSTEM python override (only used during venv
      // bootstrap), not a runtime venv path — so we validate against
      // resolveSystemPython, not the bundled venv.
      return validateSystemPythonField(value, configMetadataPath);
    default:
      return createPreflightCheck({
        key,
        status: 'idle',
        title: '',
        message: '',
      });
  }
}

function runPreflight({
  electronAppRoot,
  venvRoot,
  configMetadataPath,
  getLocalSettings,
}) {
  const paths = getPaths(electronAppRoot);
  const checks = [];
  let config = null;

  try {
    config = readConfig(paths.configPath);
    checks.push(createPreflightCheck({
      key: 'config_json',
      status: 'ok',
      titleKey: 'preflight:checks.configJson.okTitle',
      messageKey: 'preflight:checks.configJson.okMessage',
      detail: paths.configPath,
    }));
  } catch (error) {
    checks.push(createPreflightCheck({
      key: 'config_json',
      code: ERROR_CODES.CONFIG_JSON_INVALID,
      status: 'error',
      titleKey: 'preflight:checks.configJson.errorTitle',
      messageKey: 'preflight:checks.configJson.errorMessage',
      detail: error.message,
    }));
  }

  const appSettings = getLocalSettings() || {};
  checks.push(validateWhisperflowPackage(paths.pythonDir));
  checks.push(validateBundledVenv({ venvRoot, configMetadataPath, userSettings: appSettings }));
  checks.push(validateFfmpeg());
  checks.push(validateMediaRootPath(config?.SETTING?.media_root_path));
  checks.push(validateScriptPath('scan_script', paths.scanScriptPath));
  checks.push(validateScriptPath('cli_script', paths.cliScriptPath));

  const blockingChecks = checks.filter((check) => check.status === 'error');

  return {
    ok: blockingChecks.length === 0,
    checkedAt: new Date().toISOString(),
    checks,
    blockingChecks,
  };
}

module.exports = {
  runPreflight,
  validateSettingField,
};
