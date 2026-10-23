import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function getUserDataDir() {
  if (process.env.ZMOD_USER_DATA_DIR) {
    return path.resolve(process.env.ZMOD_USER_DATA_DIR);
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

export function ensureDirectories() {
  const dirs = [
    getUserDataDir(),
    getPluginsDir(),
    getThemesDir(),
    getLogsDir()
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
