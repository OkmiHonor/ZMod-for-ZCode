import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { configManager } from '../../zmod-core/src/common/config.js';

/** Find the app.asar inside a host directory (handles win/linux and macOS layouts). */
export function findAsarInHost(hostDir) {
  const candidates = [
    path.join(hostDir, 'resources', 'app.asar'),
    path.join(hostDir, 'Resources', 'app.asar'),
    path.join(hostDir, 'app.asar')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Resolve the ZCode host directory. Priority:
 * explicit --path > saved installPath (config.json) > ZCODE_PATH env > platform defaults.
 */
export function locateZCode(opts = {}) {
  const candidates = [];
  if (opts.explicit) candidates.push(opts.explicit);
  try {
    const saved = configManager.get().installPath;
    if (saved) candidates.push(saved);
  } catch {}
  if (process.env.ZCODE_PATH) candidates.push(process.env.ZCODE_PATH);

  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(localAppData, 'Programs', 'ZCode'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ZCode')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/ZCode.app/Contents/Resources',
      path.join(home, 'Applications/ZCode.app/Contents/Resources')
    );
  } else {
    candidates.push('/usr/lib/zcode', '/opt/zcode', path.join(home, '.local/share/zcode'));
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c) && findAsarInHost(c)) return c;
  }
  return null;
}

/** Best-effort path of the main executable for relaunch after deployment. */
export function findHostExe(hostDir) {
  if (process.platform === 'win32') {
    const exe = path.join(hostDir, 'ZCode.exe');
    return fs.existsSync(exe) ? exe : null;
  }
  if (process.platform === 'darwin') {
    const exe = path.resolve(hostDir, '..', '..', 'MacOS', 'ZCode');
    return fs.existsSync(exe) ? exe : null;
  }
  const exe = path.join(hostDir, 'zcode');
  return fs.existsSync(exe) ? exe : null;
}
