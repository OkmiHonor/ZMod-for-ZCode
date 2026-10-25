import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { locateZCode, findAsarInHost, findHostExe } from '../locate.js';
import { findMarkers, readHostVersion } from '../lib/asar.js';
import { MARKERS, V1_MARKERS } from '../patches/index.js';
import { isZcodeRunning } from '../lib/process.js';
import {
  getUserDataDir,
  getConfigPath,
  getPluginsDir,
  getRuntimeDir,
  getBaseSnapshotPath
} from '../../../zmod-core/src/common/paths.js';
import { configManager } from '../../../zmod-core/src/common/config.js';

/* ---- Electron fuse sentinel (ported from the v1 toolchain check-fuses.cjs) ---- */
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
const FUSE_IDX = { EnableEmbeddedAsarIntegrityValidation: 4, OnlyLoadAppFromAsar: 5 };
const FUSE_STATE = { 0x30: 'DISABLE', 0x31: 'ENABLE', 0x72: 'REMOVED', 0x90: 'INHERIT' };

function scanFuses(exePath) {
  const buf = fs.readFileSync(exePath);
  const i = buf.indexOf(FUSE_SENTINEL);
  if (i < 0) return { found: false };
  const wireLen = buf[i + FUSE_SENTINEL.length + 1];
  const wireStart = i + FUSE_SENTINEL.length + 2;
  const fuses = {};
  let tripped = false;
  for (const [name, idx] of Object.entries(FUSE_IDX)) {
    const b = idx < wireLen ? buf[wireStart + idx] : null;
    const state = b == null ? 'ABSENT' : FUSE_STATE[b] || `UNKNOWN(${b})`;
    fuses[name] = state;
    if (state === 'ENABLE') tripped = true;
  }
  return { found: true, fuses, tripped };
}

const mark = (ok, label, detail = '') =>
  console.log(`  [${ok ? '✔' : '✖'}] ${label}${detail ? ' — ' + detail : ''}`);

export async function doctor(opts = {}) {
  console.log(`\n🩺 [ZMod Doctor] v${createRequire(import.meta.url)('../../package.json').version} diagnostics report\n`);
  let failures = 0;

  console.log('• Environment');
  console.log(`  Node ${process.version} · ${process.platform}/${process.arch}`);

  const hostDir = locateZCode({ explicit: opts.path });
  const asarPath = hostDir ? findAsarInHost(hostDir) : null;
  if (!asarPath) {
    console.log('• Host');
    mark(false, 'ZCode install dir not found (--path / ZCODE_PATH / common paths all missed)');
    failures++;
  } else {
    const version = await readHostVersion(asarPath);
    console.log(`• Host: ${asarPath} (ZCode ${version}, ${(fs.statSync(asarPath).size / 1048576).toFixed(1)} MB)`);

    console.log('• asar patch markers');
    const v2 = findMarkers(asarPath, Object.values(MARKERS));
    const v1 = findMarkers(asarPath, V1_MARKERS);
    if (v1.length > 0) {
      mark(false, 'Legacy ZMod v1 inline mod detected', v1.join(', '));
      failures++;
    } else {
      const expected = Object.values(MARKERS);
      const missing = expected.filter((m) => !v2.includes(m));
      if (v2.length === 0) {
        mark(false, 'ZMod not installed (pristine official)', 'run zmod install');
      } else if (missing.length > 0) {
        mark(false, 'Incomplete patches', `missing ${missing.join(', ')}`);
        failures++;
      } else {
        mark(true, 'All four patch channels present (head/tail/preload/renderer)');
      }
    }

    console.log('• Electron fuse sentinel');
    const exe = findHostExe(hostDir);
    if (!exe) {
      mark(true, 'Host exe not found (skipping fuse scan)');
    } else {
      const fuses = scanFuses(exe);
      if (!fuses.found) mark(true, 'No embedded fuses (asar can be rebuilt freely)');
      else if (fuses.tripped) {
        mark(false, 'Fuses tripped — rebuilding asar will break client startup!', JSON.stringify(fuses.fuses));
        failures++;
      } else mark(true, 'Fuses not enabled', JSON.stringify(fuses.fuses));
    }
  }

  console.log('• External runtime');
  const userData = getUserDataDir();
  const runtimeDir = getRuntimeDir();
  const runtimeFiles = [
    path.join(runtimeDir, 'main', 'index.js'),
    path.join(runtimeDir, 'main', 'protocol.js'),
    path.join(runtimeDir, 'main', 'rpc.js'),
    path.join(runtimeDir, 'common', 'paths.js'),
    path.join(runtimeDir, 'core', 'index.js'),
    path.join(runtimeDir, 'sdk', 'index.js'),
    path.join(runtimeDir, 'sdk', 'schema.js')
  ];
  const missingRuntime = runtimeFiles.filter((f) => !fs.existsSync(f));
  mark(missingRuntime.length === 0, missingRuntime.length === 0 ? 'runtime files complete' : 'runtime files missing', missingRuntime.join(', ') || runtimeDir);

  console.log('• Data directories');
  console.log(`  User data: ${userData} [${fs.existsSync(userData) ? 'exists' : 'not initialized'}]`);
  console.log(`  Config file: ${getConfigPath()} [${fs.existsSync(getConfigPath()) ? 'exists' : 'not created'}]`);
  console.log(`  Baseline snapshot: ${getBaseSnapshotPath()} [${fs.existsSync(getBaseSnapshotPath()) ? 'exists' : 'missing (restore will be unavailable)'}]`);

  console.log('• Plugins');
  const pluginsDir = getPluginsDir();
  if (!fs.existsSync(pluginsDir)) {
    mark(false, 'Plugins dir missing', 'run zmod install to deploy');
    failures++;
  } else {
    const ids = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    if (ids.length === 0) {
      mark(false, 'Plugins dir is empty');
      failures++;
    }
    for (const id of ids) {
      const enabled = configManager.isPluginEnabled(id);
      console.log(`  [${enabled ? '✔' : ' '}] ${id.padEnd(20)} ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  console.log('• Client process');
  console.log(`  ${isZcodeRunning() ? 'ZCode is running (quit or use --force before touching the asar)' : 'not running'}`);

  console.log(`\n${failures === 0 ? '✔ Diagnostics passed' : `✖ ${failures} issue(s) found`}\n`);
  if (failures > 0) process.exitCode = 1;
}
