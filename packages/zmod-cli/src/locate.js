import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { configManager } from '../../zmod-core/src/common/config.js';
import { runningZcodeExePath } from './lib/process.js';

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
 * Custom install dirs: read the ZCode NSIS uninstall entry from the registry
 * (HKCU Uninstall\<guid>) and derive the install dir from UninstallString —
 * electron-builder does NOT write InstallLocation, but UninstallString
 * ("<dir>\Uninstall ZCode.exe") is always present.
 */
function zcodeDirFromUninstallRegistry() {
  if (process.platform !== 'win32') return null;
  const root = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  try {
    const out = execSync(`reg query "${root}" /s /f "ZCode" /d`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const keys = [
      ...new Set(
        [...out.matchAll(/HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\S+/g)].map(
          (m) => m[0]
        )
      )
    ];
    for (const key of keys) {
      try {
        const kv = execSync(`reg query "${key}" /v UninstallString`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        const line = kv.split(/\r?\n/).find((l) => l.includes('REG_SZ'));
        const raw = line?.split('REG_SZ')[1]?.trim() || '';
        const m = raw.match(/^(?:"(.*)|([^"]*))\bUninstall ZCode\.exe/i);
        const dir = (m?.[1] || m?.[2] || '').replace(/["\s]+$/, '').replace(/\\$/, '').trim();
        if (dir && findAsarInHost(dir)) return dir;
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Resolve the ZCode host directory. Priority:
 * explicit --path > saved installPath (config.json) > ZCODE_PATH env > platform defaults
 * > registry uninstall entry > running-process inference.
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
  const fromRegistry = zcodeDirFromUninstallRegistry();
  if (fromRegistry) return fromRegistry;
  // Last resort: infer the install dir from a running client's executable —
  // covers custom install locations no default candidate knows about.
  const exe = runningZcodeExePath();
  if (exe) {
    const hostDir = path.dirname(exe);
    if (findAsarInHost(hostDir)) return hostDir;
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
