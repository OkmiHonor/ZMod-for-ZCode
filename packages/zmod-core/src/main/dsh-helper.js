import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { getPluginsDir } from '../common/paths.js';

let electron = null;
try {
  electron = await import('electron');
} catch {}
const app = electron?.app ?? electron?.default?.app;

let helperChild = null;
let currentConfig = null;
let currentPetsKey = '';
let bridgeLineBuf = '';
const pendingBridgeTimers = new Set();

function resolveElectronBinary() {
  const candidates = [
    process.env.DSH_PET_ELECTRON_PATH,
    'D:\\DSH Desktop\\.dsh\\electron\\electron.exe',
    path.join(os.homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    path.join(os.homedir(), '.dsh', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function stopDshHelper() {
  if (helperChild) {
    try {
      helperChild.kill();
    } catch {}
    helperChild = null;
  }
  for (const t of pendingBridgeTimers) clearTimeout(t);
  pendingBridgeTimers.clear();
  bridgeLineBuf = '';
  currentPetsKey = '';
}

export function registerDshHelper(gateway) {
  if (app && typeof app.on === 'function') {
    app.on('before-quit', () => stopDshHelper());
  }

  gateway.register('dsh.syncHelper', async ({ activeConfig, enabled }) => {
    if (enabled === false) {
      stopDshHelper();
      return { ok: true, active: false, reason: 'disabled' };
    }

    const pets = Array.isArray(activeConfig?.pets) ? activeConfig.pets : [];
    const desktopPets = pets.filter((p) => p.display === 'desktop' || p.display === 'both');
    if (desktopPets.length === 0) {
      stopDshHelper();
      return { ok: true, active: false, reason: 'no-desktop-pets' };
    }

    const electronExe = resolveElectronBinary();
    if (!electronExe) {
      console.warn('[ZMod:DshHelper] electron.exe not found for desktop pet helper');
      return { ok: false, error: 'electron-not-found' };
    }

    const dshPetDir = path.join(getPluginsDir(), 'dsh-compat', 'dsh-plugins', 'dsh-pet');
    const helperMain = path.join(dshPetDir, 'runtime', 'electron-helper', 'main.js');
    if (!fs.existsSync(helperMain)) {
      console.warn('[ZMod:DshHelper] helper main.js not found at', helperMain);
      return { ok: false, error: 'helper-not-found' };
    }

    currentConfig = activeConfig;
    const petsKey = JSON.stringify(desktopPets.map((p) => ({ id: p.id, size: p.size, pos: p.position })));
    if (helperChild && petsKey === currentPetsKey) {
      return { ok: true, active: true };
    }

    // Stop previous instance before restarting with new pets
    stopDshHelper();
    currentPetsKey = petsKey;

    try {
      const child = spawn(electronExe, [helperMain], {
        env: {
          ...process.env,
          DSH_PET_CONFIG_URL: 'http://127.0.0.1:3080/dsh-pet-7340/config',
          DSH_PET_SITE_URL: 'http://127.0.0.1:3080',
          DSH_PET_OPEN_TARGET: 'desktop',
          DSH_PET_SCALE: '1',
          DSH_PET_BRIDGE: '1',
          DSH_PET_PETS: JSON.stringify(desktopPets.map((p, i) => ({ id: p.id, size: p.size || 462, index: i }))),
          DSH_PET_HOST_PID: String(process.pid)
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      helperChild = child;
      bridgeLineBuf = '';

      child.stdout.on('data', (d) => {
        bridgeLineBuf += d.toString();
        let idx;
        while ((idx = bridgeLineBuf.indexOf('\n')) !== -1) {
          const line = bridgeLineBuf.slice(0, idx).trim();
          bridgeLineBuf = bridgeLineBuf.slice(idx + 1);
          if (line.startsWith('dsh-pet-bridge:')) {
            try {
              const req = JSON.parse(line.slice('dsh-pet-bridge:'.length));
              handleBridgeRequest(req, dshPetDir, currentConfig);
            } catch (err) {
              console.error('[ZMod:DshHelper] bridge parse error:', err);
            }
          }
        }
      });

      child.stderr.on('data', (d) => {
        const line = d.toString().trim();
        if (line && !line.includes('displays:') && !line.includes('forcedScaleFactor=')) {
          console.warn('[ZMod:DshHelper]', line);
        }
      });

      child.on('exit', (code, sig) => {
        if (helperChild === child) {
          helperChild = null;
          console.log(`[ZMod:DshHelper] desktop helper exited (code=${code}, sig=${sig})`);
        }
      });

      return { ok: true, active: true, pid: child.pid };
    } catch (err) {
      console.error('[ZMod:DshHelper] launch failed:', err);
      return { ok: false, error: String(err?.message || err) };
    }
  });

  gateway.register('dsh.stopHelper', async () => {
    stopDshHelper();
    return { ok: true };
  });
}

function sendBridgeResponse(cb, resp) {
  try {
    const u = new URL(cb);
    const postReq = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    postReq.on('error', () => {});
    postReq.write(JSON.stringify(resp));
    postReq.end();
  } catch {}
}

function handleBridgeRequest(req, dshPetDir, config) {
  if (!req.cb) return;
  const url = String(req.url || '');

  if (url.includes('/config')) {
    sendBridgeResponse(req.cb, {
      id: req.id,
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ main: config })
    });
    return;
  }

  if (url.includes('/state')) {
    const hasSince = /[?&]since=/.test(url);
    const timeoutMatch = url.match(/[?&]timeout(?:Ms)?=(\d+)/);
    const timeoutMs = timeoutMatch ? Math.min(30000, Math.max(1000, Number(timeoutMatch[1]))) : 15000;
    // 非数字 counter 使客户端 longPoll 为 false，降级为每秒 1 次的定时轮询，绝不 0 延迟死循环
    const body = JSON.stringify({ counter: undefined, sections: {}, pets: {} });

    if (hasSince) {
      // 若带 since，挂起等待 timeoutMs，避免客户端频繁重试
      const timer = setTimeout(() => {
        pendingBridgeTimers.delete(timer);
        sendBridgeResponse(req.cb, { id: req.id, status: 200, contentType: 'application/json', body });
      }, timeoutMs);
      pendingBridgeTimers.add(timer);
      return;
    }

    sendBridgeResponse(req.cb, { id: req.id, status: 200, contentType: 'application/json', body });
    return;
  }

  let resp = { id: req.id, status: 200, contentType: 'application/json', body: '{}' };
  if (url.includes('/thumb/')) {
    const parts = url.split('/thumb/')[1] || '';
    const name = decodeURIComponent(parts.split('/')[1] || parts);
    const file = path.join(dshPetDir, 'assets', 'webm', name);
    resp = { id: req.id, status: 200, contentType: 'video/webm', file };
  } else if (url.includes('/pic/')) {
    const name = decodeURIComponent(url.split('/pic/')[1] || '');
    const file = path.join(dshPetDir, 'assets', 'pic', name);
    resp = { id: req.id, status: 200, contentType: 'image/png', file };
  } else if (url.includes('/font/')) {
    const name = decodeURIComponent(url.split('/font/')[1] || '');
    const file = path.join(dshPetDir, 'assets', 'fonts', name);
    resp = { id: req.id, status: 200, contentType: 'font/ttf', file };
  } else {
    // /pose/report, /balance, /whisper, etc.
    resp = { id: req.id, status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) };
  }

  sendBridgeResponse(req.cb, resp);
}
