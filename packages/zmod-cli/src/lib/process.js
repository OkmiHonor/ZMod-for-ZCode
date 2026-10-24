import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';

/** Best-effort detection of a running ZCode client (locks the asar on Windows). */
export function isZcodeRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /NH', { encoding: 'utf8' });
      return out.toLowerCase().includes('zcode.exe');
    }
    const out = execSync('pgrep -x ZCode || pgrep -x zcode || true', { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Executable path of a running ZCode client, used to infer custom install dirs
 * that no default-path candidate covers. Null when not running / unavailable.
 */
export function runningZcodeExePath() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "(Get-Process ZCode -ErrorAction SilentlyContinue | Select-Object -First 1).Path"',
        { encoding: 'utf8' }
      );
      const p = out.trim();
      return p && fs.existsSync(p) ? p : null;
    }
    const out = execSync('pgrep -x ZCode || pgrep -x zcode || true', { encoding: 'utf8' });
    const pid = out.trim().split('\n')[0];
    if (!pid) return null;
    const p = fs.realpathSync(`/proc/${pid}/exe`);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Force-kill the client. Deliberately NO /T (tree kill): if this CLI was launched
 * from ZCode's own embedded terminal, /T would kill our own process tree.
 */
export function killZcode() {
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /f /im ZCode.exe', { stdio: 'ignore' });
    } else {
      execSync('pkill -x ZCode; pkill -x zcode', { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

export function launchDetached(exePath) {
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
