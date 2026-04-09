'use strict';

const fs = require('fs');
const path = require('path');
const { readConfig } = require('./config-manager');
const { resolvePoetryPath } = require('./path-resolver');

function getPaths(electronAppRoot) {
  const pythonDir = path.join(electronAppRoot, 'python');
  return {
    configPath: path.join(pythonDir, 'config', 'config.json'),
    scanScriptPath: path.join(pythonDir, 'config_setting.py'),
    cliScriptPath: path.join(electronAppRoot, 'bridge', 'run_cli.py'),
  };
}

function createCheck({
  key,
  status,
  title,
  message,
  detail = '',
  action = null,
}) {
  return { key, status, title, message, detail, action };
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

function validatePoetryPath(value, configMetadataPath) {
  const explicitPath = typeof value === 'string' ? value.trim() : '';
  const resolvedPath = resolvePoetryPath(explicitPath, configMetadataPath);

  if (explicitPath && !isExistingFile(explicitPath)) {
    return createCheck({
      key: 'poetryPath',
      status: 'error',
      title: 'Poetry 路徑不存在',
      message: '請確認 Poetry 可執行檔路徑正確，或清空此欄位改用自動偵測。',
      detail: explicitPath,
      action: { type: 'open-settings', section: 'APP_SETTINGS', key: 'poetryPath' },
    });
  }

  if (!resolvedPath) {
    return createCheck({
      key: 'poetryPath',
      status: 'error',
      title: '找不到 Poetry',
      message: '請在 Settings 指定 Poetry 路徑，否則無法啟動轉錄流程。',
      detail: explicitPath || 'No Poetry executable could be resolved from the current settings or PATH.',
      action: { type: 'open-settings', section: 'APP_SETTINGS', key: 'poetryPath' },
    });
  }

  return createCheck({
    key: 'poetryPath',
    status: 'ok',
    title: 'Poetry 已就緒',
    message: explicitPath ? '將使用你指定的 Poetry 路徑。' : '將使用自動偵測到的 Poetry 路徑。',
    detail: resolvedPath,
  });
}

function validateWhisperToolPath(value) {
  const toolPath = typeof value === 'string' ? value.trim() : '';

  if (!toolPath) {
    return createCheck({
      key: 'whisper_faster_tool_path',
      status: 'error',
      title: 'Whisper 工具路徑未設定',
      message: '請在 Settings 指定 faster-whisper-webui 專案資料夾。',
      action: { type: 'open-settings', section: 'SETTING', key: 'whisper_faster_tool_path' },
    });
  }

  if (!isExistingDirectory(toolPath)) {
    return createCheck({
      key: 'whisper_faster_tool_path',
      status: 'error',
      title: 'Whisper 工具路徑不存在',
      message: '指定的 faster-whisper-webui 路徑不存在，請重新選擇。',
      detail: toolPath,
      action: { type: 'open-settings', section: 'SETTING', key: 'whisper_faster_tool_path' },
    });
  }

  const poetryProjectFile = path.join(toolPath, 'pyproject.toml');
  if (!isExistingFile(poetryProjectFile)) {
    return createCheck({
      key: 'whisper_faster_tool_path',
      status: 'error',
      title: 'Whisper 工具路徑不是 Poetry 專案',
      message: '這個資料夾內找不到 pyproject.toml，請確認你選的是 faster-whisper-webui 專案根目錄。',
      detail: poetryProjectFile,
      action: { type: 'open-settings', section: 'SETTING', key: 'whisper_faster_tool_path' },
    });
  }

  return createCheck({
    key: 'whisper_faster_tool_path',
    status: 'ok',
    title: 'Whisper 工具路徑已就緒',
    message: 'faster-whisper-webui 專案路徑有效。',
    detail: toolPath,
  });
}

function validateMediaRootPath(value) {
  const mediaRootPath = typeof value === 'string' ? value.trim() : '';

  if (!mediaRootPath) {
    return createCheck({
      key: 'media_root_path',
      status: 'error',
      title: 'Media Directory 尚未設定',
      message: '請先選擇要掃描的媒體資料夾。',
      action: { type: 'browse-media-root' },
    });
  }

  if (!isExistingDirectory(mediaRootPath)) {
    return createCheck({
      key: 'media_root_path',
      status: 'error',
      title: 'Media Directory 不存在',
      message: '目前設定的媒體資料夾不存在，請重新選擇。',
      detail: mediaRootPath,
      action: { type: 'browse-media-root' },
    });
  }

  return createCheck({
    key: 'media_root_path',
    status: 'ok',
    title: 'Media Directory 已就緒',
    message: '媒體掃描資料夾有效。',
    detail: mediaRootPath,
  });
}

function validateScriptPath(key, scriptPath, title) {
  if (isExistingFile(scriptPath)) {
    return createCheck({
      key,
      status: 'ok',
      title: `${title} 已就緒`,
      message: `${title} 存在。`,
      detail: scriptPath,
    });
  }

  return createCheck({
    key,
    status: 'error',
    title: `${title} 缺失`,
    message: `${title} 不存在，請確認應用程式資源是否完整。`,
    detail: scriptPath,
  });
}

function validateSettingField({ key, value, configMetadataPath }) {
  switch (key) {
    case 'poetryPath':
      return validatePoetryPath(value, configMetadataPath);
    case 'whisper_faster_tool_path':
      return validateWhisperToolPath(value);
    case 'media_root_path':
      return validateMediaRootPath(value);
    default:
      return createCheck({
        key,
        status: 'idle',
        title: '',
        message: '',
      });
  }
}

function runPreflight({ electronAppRoot, configMetadataPath, getLocalSettings }) {
  const paths = getPaths(electronAppRoot);
  const checks = [];
  let config = null;

  try {
    config = readConfig(paths.configPath);
    checks.push(createCheck({
      key: 'config_json',
      status: 'ok',
      title: '設定檔已載入',
      message: 'config.json 已成功載入。',
      detail: paths.configPath,
    }));
  } catch (error) {
    checks.push(createCheck({
      key: 'config_json',
      status: 'error',
      title: '設定檔無法讀取',
      message: 'config.json 無法讀取或格式錯誤。',
      detail: error.message,
    }));
  }

  const appSettings = getLocalSettings() || {};
  checks.push(validatePoetryPath(appSettings.poetryPath, configMetadataPath));
  checks.push(validateWhisperToolPath(config?.SETTING?.whisper_faster_tool_path));
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
