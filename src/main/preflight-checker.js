'use strict';

const fs = require('fs');
const path = require('path');
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

function validateWhisperflowPackage(pythonDir) {
  const packageInit = path.join(pythonDir, 'whisperflow', '__init__.py');
  if (isExistingFile(packageInit)) {
    return createPreflightCheck({
      key: 'whisperflow_package',
      status: 'ok',
      title: 'WhisperFlow 核心已就緒',
      message: '內建的 whisperflow Python 套件已安裝。',
      detail: packageInit,
    });
  }

  return createPreflightCheck({
    key: 'whisperflow_package',
    code: ERROR_CODES.WHISPERFLOW_PACKAGE_MISSING,
    status: 'error',
    title: 'WhisperFlow 核心不存在',
    message: '找不到內建的 whisperflow Python 套件，應用程式資源可能已損毀。',
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
      title: 'Python 環境已就緒',
      message: '使用應用程式內建的虛擬環境執行轉錄。',
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
      title: '找不到 Python 3',
      message: '找不到系統 Python 3 來建立虛擬環境。請安裝 Python 3.10 以上版本，或在 Settings 指定 python 可執行檔路徑。',
      action: { type: 'open-settings', section: 'APP_SETTINGS', key: 'pythonPath' },
    });
  }

  return createPreflightCheck({
    key: 'bundled_python',
    code: ERROR_CODES.VENV_NOT_INITIALIZED,
    status: 'warning',
    title: 'Python 虛擬環境尚未建立',
    message: '第一次執行轉錄時會自動建立虛擬環境並安裝依賴（約數百 MB）。',
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
      title: 'Python 路徑不存在',
      message: '指定的 Python 可執行檔不存在，請重新選擇或清空此欄位以使用自動偵測。',
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
      title: '找不到 Python 3',
      message: '找不到 Python 3.10+。請安裝後重試，或在這裡指定 python 可執行檔路徑。',
      action: { type: 'open-settings', section: 'APP_SETTINGS', key: 'pythonPath' },
    });
  }

  return createPreflightCheck({
    key: 'pythonPath',
    status: 'ok',
    title: 'Python 已就緒',
    message: explicit
      ? '將使用你指定的 Python 路徑建立虛擬環境。'
      : '將使用自動偵測到的系統 Python 建立虛擬環境。',
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
      title: 'Media Directory 尚未設定',
      message: '請先選擇要掃描的媒體資料夾。',
      action: { type: 'browse-media-root' },
    });
  }

  if (!isExistingDirectory(mediaRootPath)) {
    return createPreflightCheck({
      key: 'media_root_path',
      code: ERROR_CODES.MEDIA_ROOT_NOT_FOUND,
      status: 'error',
      title: 'Media Directory 不存在',
      message: '目前設定的媒體資料夾不存在，請重新選擇。',
      detail: mediaRootPath,
      action: { type: 'browse-media-root' },
    });
  }

  return createPreflightCheck({
    key: 'media_root_path',
    status: 'ok',
    title: 'Media Directory 已就緒',
    message: '媒體掃描資料夾有效。',
    detail: mediaRootPath,
  });
}

function validateScriptPath(key, scriptPath, title) {
  if (isExistingFile(scriptPath)) {
    return createPreflightCheck({
      key,
      status: 'ok',
      title: `${title} 已就緒`,
      message: `${title} 存在。`,
      detail: scriptPath,
    });
  }

  return createPreflightCheck({
    key,
    code: key === 'scan_script' ? ERROR_CODES.SCAN_SCRIPT_NOT_FOUND : ERROR_CODES.CLI_ENTRY_NOT_FOUND,
    status: 'error',
    title: `${title} 缺失`,
    message: `${title} 不存在，請確認應用程式資源是否完整。`,
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
      title: '設定檔已載入',
      message: 'config.json 已成功載入。',
      detail: paths.configPath,
    }));
  } catch (error) {
    checks.push(createPreflightCheck({
      key: 'config_json',
      code: ERROR_CODES.CONFIG_JSON_INVALID,
      status: 'error',
      title: '設定檔無法讀取',
      message: 'config.json 無法讀取或格式錯誤。',
      detail: error.message,
    }));
  }

  const appSettings = getLocalSettings() || {};
  checks.push(validateWhisperflowPackage(paths.pythonDir));
  checks.push(validateBundledVenv({ venvRoot, configMetadataPath, userSettings: appSettings }));
  checks.push(validateMediaRootPath(config?.SETTING?.media_root_path));
  checks.push(validateScriptPath('scan_script', paths.scanScriptPath, '掃描腳本'));
  checks.push(validateScriptPath('cli_script', paths.cliScriptPath, 'CLI 腳本'));

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
