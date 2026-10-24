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
