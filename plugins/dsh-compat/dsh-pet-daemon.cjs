/**
 * ZMod DSH-Pet Desktop Daemon
 *
 * 守护进程：为 dsh-pet 提供独立的操作系统级透明置顶小窗口服务。
 * 绑定 ZCode.exe 进程生命周期：ZCode 存活则常驻桌面，ZCode 退出则自动自毁。
 */
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');

const dataDir = path.resolve(__dirname, '..', '..');
const configFile = path.join(dataDir, 'config.json');
const dshPetDir = path.join(__dirname, 'dsh-plugins', 'dsh-pet');
const helperMain = path.join(dshPetDir, 'runtime', 'electron-helper', 'main.js');

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

function findZCodePid() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /FO CSV /NH', { encoding: 'utf8' });
    const lines = out.trim().split('\n');
    for (const line of lines) {
      const parts = line.split(',');
      if (parts[1]) {
        const pid = parseInt(parts[1].replace(/"/g, ''), 10);
        if (pid > 0) return pid;
      }
    }
  } catch {}
  return 0;
}

let helperChild = null;
let currentPetsKey = '';
let bridgeLineBuf = '';

function loadActiveConfig() {
  const { DEFAULT_PET_CONFIG } = require('./lib.js');
  try {
    if (fs.existsSync(configFile)) {
      const globalCfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const userCfg = globalCfg?.plugins?.['dsh-compat']?.settings?.petUserConfig;
      if (userCfg && typeof userCfg === 'object') {
        return {
          ...DEFAULT_PET_CONFIG,
          ...userCfg,
          animations: DEFAULT_PET_CONFIG.animations,
          animationWeights: DEFAULT_PET_CONFIG.animationWeights,
          eventsRefreshSec: DEFAULT_PET_CONFIG.eventsRefreshSec
        };
      }
    }
  } catch {}
  return DEFAULT_PET_CONFIG;
}

function stopHelper() {
  if (helperChild) {
    try { helperChild.kill(); } catch {}
    helperChild = null;
  }
  bridgeLineBuf = '';
  currentPetsKey = '';
}

function syncHelper() {
  const electronExe = resolveElectronBinary();
  if (!electronExe || !fs.existsSync(helperMain)) return;

  const config = loadActiveConfig();
  const pets = Array.isArray(config?.pets) ? config.pets : [];
  const desktopPets = pets.filter((p) => p.display === 'desktop' || p.display === 'both');

  if (desktopPets.length === 0) {
    stopHelper();
    return;
  }

  const petsKey = JSON.stringify(desktopPets.map((p) => ({ id: p.id, size: p.size, pos: p.position })));
  if (helperChild && petsKey === currentPetsKey) {
    return;
  }

  stopHelper();
  currentPetsKey = petsKey;

  const zcodePid = findZCodePid() || process.pid;

  const child = spawn(electronExe, [helperMain], {
    env: {
      ...process.env,
      DSH_PET_CONFIG_URL: 'http://127.0.0.1:3080/dsh-pet-7340/config',
      DSH_PET_SITE_URL: 'http://127.0.0.1:3080',
      DSH_PET_OPEN_TARGET: 'desktop',
      DSH_PET_SCALE: '1',
      DSH_PET_BRIDGE: '1',
      DSH_PET_PETS: JSON.stringify(desktopPets.map((p, i) => ({ id: p.id, size: p.size || 462, index: i }))),
      DSH_PET_HOST_PID: String(zcodePid)
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
          handleBridgeRequest(req, dshPetDir, loadActiveConfig());
        } catch {}
      }
    }
  });

  child.stderr.on('data', () => {});
  child.on('exit', () => {
    if (helperChild === child) {
      helperChild = null;
      currentPetsKey = '';
    }
  });
}

function handleBridgeRequest(req, dshPetDir, config) {
  if (!req.cb) return;
  const url = String(req.url || '');
  let resp = { id: req.id, status: 200, contentType: 'application/json', body: '{}' };

  if (url.includes('/config')) {
    resp = { id: req.id, status: 200, contentType: 'application/json', body: JSON.stringify({ main: config }) };
  } else if (url.includes('/state')) {
    resp = { id: req.id, status: 200, contentType: 'application/json', body: JSON.stringify({ counter: 1, sections: {} }) };
  } else if (url.includes('/thumb/')) {
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
    resp = { id: req.id, status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) };
  }

  try {
    const u = new URL(req.cb);
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

// 主循环：每 2s 探测 ZCode 进程与配置文件变动
const hostPid = findZCodePid();
if (!hostPid) {
  process.exit(0);
}

syncHelper();

let lastConfigMtime = 0;
setInterval(() => {
  try {
    process.kill(hostPid, 0);
  } catch {
    stopHelper();
    process.exit(0);
  }

  try {
    if (fs.existsSync(configFile)) {
      const st = fs.statSync(configFile);
      if (st.mtimeMs !== lastConfigMtime) {
        lastConfigMtime = st.mtimeMs;
        syncHelper();
      }
    }
  } catch {}
}, 2000);

process.on('SIGINT', () => { stopHelper(); process.exit(0); });
process.on('SIGTERM', () => { stopHelper(); process.exit(0); });
process.on('exit', () => { stopHelper(); });
