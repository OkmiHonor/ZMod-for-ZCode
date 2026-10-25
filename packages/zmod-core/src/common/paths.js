import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ZMod 数据目录解析优先级：
 * 1. ZMOD_USER_DATA_DIR 环境变量（显式覆盖）
 * 2. 部署后的运行时（<data>/runtime/common|main/…）→ 数据目录即 runtime 的上级
 * 3. CLI / 安装目录上下文：向上找含 packages/zmod-cli/bin/zmod.js 的 ZMod 主目录 → <主目录>/data
 * 4. 兜底：传统 %APPDATA%/ZMod
 * 数据目录跟随程序目录，卸载"保留用户数据"选项即可整体带走。
 */
export function getUserDataDir() {
  if (process.env.ZMOD_USER_DATA_DIR) {
    return path.resolve(process.env.ZMOD_USER_DATA_DIR);
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  const runtimeParent = path.basename(path.dirname(moduleDir));
  if (runtimeParent === 'runtime') {
    // deployed runtime: <data>/runtime/{main,common}/… → dirname(moduleDir)
    // is already <data>/runtime; one level up is the data dir
    return path.resolve(path.dirname(moduleDir), '..');
  }

  let dir = moduleDir;
  for (let i = 0; i < 8; i++) {
    dir = path.dirname(dir);
    if (fs.existsSync(path.join(dir, 'packages', 'zmod-cli', 'bin', 'zmod.js'))) {
      return path.join(dir, 'data');
    }
  }

  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'ZMod');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ZMod');
  }
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'zmod')
    : path.join(home, '.config', 'zmod');
}

/** 旧版独立数据目录（%APPDATA%/ZMod 等），供迁移判断用。 */
export function getLegacyUserDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'ZMod');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ZMod');
  }
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'zmod')
    : path.join(home, '.config', 'zmod');
}

export function getConfigPath() {
  return path.join(getUserDataDir(), 'config.json');
}

export function getVaultPath() {
  return path.join(getUserDataDir(), 'secure.vault');
}

export function getPluginsDir() {
  return path.join(getUserDataDir(), 'plugins');
}

export function getThemesDir() {
  return path.join(getUserDataDir(), 'themes');
}

export function getLogsDir() {
  return path.join(getUserDataDir(), 'logs');
}

export function getRuntimeDir() {
  return path.join(getUserDataDir(), 'runtime');
}

export function getBaseDir() {
  return path.join(getUserDataDir(), 'base');
}

export function getBaseSnapshotPath() {
  return path.join(getBaseDir(), 'app.asar');
}

export function getTmpDir() {
  return path.join(getUserDataDir(), 'tmp');
}

export function ensureDirectories() {
  const dirs = [
    getUserDataDir(),
    getPluginsDir(),
    getThemesDir(),
    getLogsDir(),
    getRuntimeDir(),
    getBaseDir(),
    getTmpDir()
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
