import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createRequire } from 'node:module';
import { locateZCode, findAsarInHost, findHostExe } from '../locate.js';
import { findMarkers, extractAll, packAndVerify, getUnpackedSet } from '../lib/asar.js';
import { isZcodeRunning, killZcode, launchDetached, sleep } from '../lib/process.js';
import { resolveBaselineCandidate, backfillBaseSnapshot, getHostVersion, getGlobalBaselinePath } from '../lib/baseline.js';
import { MARKERS, V1_MARKERS, patchMainSource, patchPreloadSource, patchIndexHtmlSource } from '../patches/index.js';
import {
  ensureDirectories,
  getUserDataDir,
  getLegacyUserDataDir,
  getBaseSnapshotPath,
  getPluginsDir,
  getTmpDir,
  getLogsDir
} from '../../../zmod-core/src/common/paths.js';
import { configManager } from '../../../zmod-core/src/common/config.js';
import { readInstalled, removeInstalled } from '../../../zmod-core/src/common/installed.js';
import { writeBuiltinRecords } from '../../../zmod-core/src/main/plugin-host.js';

const VERSION = createRequire(import.meta.url)('../../package.json').version;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * Mirror all installer console output to logs/install-latest.log. The NSIS
 * setup exe shows only a transient console; without this, failed installs
 * leave zero trace (tmp is wiped by the finally block).
 */
export function teeConsoleTo(logPath) {
  try {
    fs.writeFileSync(logPath, '', 'utf8'); // fresh log each run
  } catch {}
  const write = (args) => {
    try {
      fs.appendFileSync(logPath, args.map(String).join(' ') + '\n', 'utf8');
    } catch {} // logging must never break the install itself
  };
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { origLog(...a); write(a); };
  console.error = (...a) => { origErr(...a); write(a); };
}

/**
 * Remove leftover tmp/install-* from earlier runs whose cleanup failed.
 * Fire-and-forget: the data dir may sit under OneDrive where deleting a
 * huge stale extract tree takes minutes of per-file sync — never block
 * the install on it (async rm keeps running while the install proceeds;
 * if the process exits first, the next run retries).
 */
export function cleanStaleTmp() {
  const legacyTmpRoot = getTmpDir();
  let entries;
  try {
    entries = fs.readdirSync(legacyTmpRoot);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.startsWith('install-')) {
      fs.rm(path.join(legacyTmpRoot, ent), { recursive: true, force: true }, () => {});
    }
  }
}

/**
 * One-time migration: old releases kept user data in %APPDATA%/ZMod; data now
 * lives inside the ZMod program dir (<home>/data). Rename when possible,
 * copy+remove across drives.
 */
export function migrateLegacyDataDir() {
  const legacy = getLegacyUserDataDir();
  const target = getUserDataDir();
  if (path.resolve(legacy) === path.resolve(target)) return;
  if (!fs.existsSync(legacy) || fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(legacy, target);
    console.log(`• User data migrated: ${legacy} -> ${target}`);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      console.error(`✖ Legacy data dir migration failed (${err.message}), continuing with: ${legacy}`);
      return;
    }
    try {
      fs.cpSync(legacy, target, { recursive: true });
      fs.rmSync(legacy, { recursive: true, force: true });
      console.log(`• User data migrated (cross-drive copy): ${legacy} -> ${target}`);
    } catch (err2) {
      console.error(`✖ Legacy data dir migration failed (${err2.message}), continuing with: ${legacy}`);
    }
  }
}

/** Deploy the runtime (main/core/sdk) into the user data dir. */
function deployRuntimeAndPlugins() {
  const userData = getUserDataDir();
  const runtimeDir = path.join(userData, 'runtime');

  copyDir(path.join(REPO_ROOT, 'packages', 'zmod-core', 'src', 'common'), path.join(runtimeDir, 'common'));
  copyDir(path.join(REPO_ROOT, 'packages', 'zmod-core', 'src', 'main'), path.join(runtimeDir, 'main'));

  const coreDir = path.join(runtimeDir, 'core');
  fs.rmSync(coreDir, { recursive: true, force: true });
  fs.mkdirSync(coreDir, { recursive: true });
  // The renderer kernel may split into sibling ES modules; deploy the whole
  // renderer directory flat (index.js + its relative imports).
  for (const ent of fs.readdirSync(
    path.join(REPO_ROOT, 'packages', 'zmod-core', 'src', 'renderer')
  )) {
    if (ent.endsWith('.js')) {
      fs.copyFileSync(
        path.join(REPO_ROOT, 'packages', 'zmod-core', 'src', 'renderer', ent),
        path.join(coreDir, ent)
      );
    }
  }

  copyDir(path.join(REPO_ROOT, 'packages', 'zmod-sdk', 'src'), path.join(runtimeDir, 'sdk'));

  // 基座不再随发任何插件：数据源 provider 已并入渲染内核（builtin-providers.js），
  // 官方插件改为市场独立分发（registry 只列 quota-popover）。升级安装时清理已
  // 退役插件的残留目录；用户自装/市场安装的第三方插件一律不动。
  const RETIRED_PLUGINS = ['official-providers', 'account-quota'];
  for (const id of RETIRED_PLUGINS) {
    fs.rmSync(path.join(getPluginsDir(), id), { recursive: true, force: true });
  }
  // 基座随发插件记账为 builtin（面板按 installed.source==='builtin' 识别）。
  // 随发插件集已为空（空转路径，保留以兼容既有账本语义），但上面的退役清理
  // 依赖这段把对应 builtin 账本记录一并移除。记账失败不阻断安装。
  try {
    const dataDir = getUserDataDir();
    const ledger = readInstalled(dataDir);
    for (const [id, rec] of Object.entries(ledger.plugins)) {
      if (
        rec?.source === 'builtin' &&
        !shipped.has(id) &&
        !fs.existsSync(path.join(getPluginsDir(), id))
      ) {
        removeInstalled(dataDir, id);
      }
    }
    writeBuiltinRecords(dataDir, [...shipped]);
  } catch (err) {
    console.warn(`⚠ Builtin plugin ledger update failed (install continues): ${err?.message || err}`);
  }
  return runtimeDir;
}

export async function install(opts = {}) {
  migrateLegacyDataDir();
  ensureDirectories();
  teeConsoleTo(path.join(getLogsDir(), 'install-latest.log'));
  console.log(`\n🚀 [ZMod Installer] v${VERSION} — ${new Date().toISOString()}\n`);

  const hostDir = locateZCode({ explicit: opts.path });
  if (!hostDir) {
    console.error('✖ ZCode install directory not found. Use --path <dir> or set the ZCODE_PATH env var.');
    process.exit(1);
  }
  const asarPath = findAsarInHost(hostDir);
  console.log(`• Host directory: ${hostDir}`);

  ensureDirectories();
  const baseSnapshot = getBaseSnapshotPath();
  cleanStaleTmp();
  // Install staging lives in the OS temp dir, never in the data dir: the data
  // dir may sit under OneDrive, where extracting/re-deleting a ~1.2 GB tree
  // syncs file-by-file and can stall the install for many minutes.
  const tmpRoot = path.join(os.tmpdir(), `zmod-install-${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });

  try {
    // ---- 1. Determine the pristine source ----
    const v1Hits = findMarkers(asarPath, V1_MARKERS);
    if (v1Hits.length > 0) {
      console.error(`✖ Legacy ZMod v1 (inline mod) markers detected: ${v1Hits.join(', ')}`);
      console.error('  Refusing to proceed to protect your install. Restore the pristine official client with the v1 toolchain first, then install.');
      process.exit(1);
    }
    const v2Hits = findMarkers(asarPath, Object.values(MARKERS));
    const hostVersion = getHostVersion(hostDir, findHostExe);
    const globalBaseline = getGlobalBaselinePath(hostVersion);
    if (hostVersion) console.log(`• Host version: ZCode ${hostVersion}`);
    let pristineSource;
    if (v2Hits.length > 0) {
      const candidate = resolveBaselineCandidate({ baseSnapshot, asarPath, explicit: opts.baseline, globalBaseline });
      if (!candidate) {
        console.error('✖ asar is already ZMod-patched and no official baseline was found (base/app.asar, machine-level cache and app.asar.backup1 are all missing).');
        console.error('  Recovery options (pick one):');
        console.error('  1. zmod install --baseline <path to the pristine official app.asar>');
        console.error('  2. Reinstall the ZCode client to restore the official asar, then install ZMod again');
        process.exit(1);
      }
      console.log(`• Existing ZMod install detected, reinstalling from ${candidate.label}`);
      pristineSource = candidate.path;
      if (backfillBaseSnapshot(baseSnapshot, pristineSource, { hostVersion })) {
        console.log('• Backfilled baseline snapshot base/app.asar');
      }
    } else {
      pristineSource = asarPath;
      // snapshot the pristine official asar — future reinstalls and `restore` depend on it
      console.log('• Pristine official client detected, snapshotting baseline to base/app.asar' + (hostVersion ? ' and machine-level cache' : ''));
      backfillBaseSnapshot(baseSnapshot, asarPath, { hostVersion });
    }

    // ---- 2. Extract + patch ----
    const extractDir = path.join(tmpRoot, 'extract');
    console.log('• Extracting official asar...');
    const unpackedHint = `${asarPath}.unpacked`;
    await extractAll(pristineSource, extractDir, fs.existsSync(unpackedHint) ? unpackedHint : null);

    const mainPath = path.join(extractDir, 'out', 'main', 'index.js');
    const preloadPath = path.join(extractDir, 'out', 'preload', 'index.cjs');
    const htmlPath = path.join(extractDir, 'out', 'renderer', 'index.html');
    for (const f of [mainPath, preloadPath, htmlPath]) {
      if (!fs.existsSync(f)) {
        console.error(`✖ Unexpected host layout, missing ${path.relative(extractDir, f)}`);
        process.exit(1);
      }
    }

    const main = patchMainSource(fs.readFileSync(mainPath, 'utf8'), VERSION, getUserDataDir());
    fs.writeFileSync(mainPath, main.code, 'utf8');
    const preload = patchPreloadSource(fs.readFileSync(preloadPath, 'utf8'), VERSION);
    fs.writeFileSync(preloadPath, preload.code, 'utf8');
    const html = patchIndexHtmlSource(fs.readFileSync(htmlPath, 'utf8'), VERSION);
    fs.writeFileSync(htmlPath, html.code, 'utf8');
    console.log(
      `• Patches: main(head${main.changed ? '✔' : '=0'}+tail) preload${preload.changed ? '✔' : '=0'} renderer${html.changed ? '✔' : '=0'}`
    );

    // ---- 3. Repack + verify ----
    console.log('• Repacking asar (verifying node-pty/ssh2 native unpack set)...');
    const newAsar = path.join(tmpRoot, 'app.asar.new');
    const unpackedCount = await packAndVerify(extractDir, newAsar, pristineSource);
    console.log(`• Unpacked set matches baseline: ${unpackedCount} entries`);

    // ---- 4. Deploy runtime (no client restart needed for this part) ----
    const runtimeDir = deployRuntimeAndPlugins();
    console.log(`• Runtime deployed (pure base, no bundled plugins): ${runtimeDir}`);
    // 升级安装清理旧版残留：run-install.cmd 新版已不分发（NSIS 卸载兜底也会删）
    try {
      fs.rmSync(path.join(path.dirname(getUserDataDir()), 'run-install.cmd'), { force: true });
    } catch {}

    // ---- 5. Swap the asar (evidence-based lock handling: try first) ----
    let killed = false;
    if (opts.force && isZcodeRunning()) {
      console.log('• --force: killing ZCode process...');
      killZcode();
      killed = true;
      await sleep(2000);
    }
    const swapTmp = `${asarPath}.zmod-new`;
    fs.copyFileSync(newAsar, swapTmp);
    let swapped = false;
    let lockErr = null;
    // Generous retry window: after a taskkill the OS may take seconds to
    // release asar handles, and the client may have been relaunched mid-install.
    for (let i = 0; i < 6 && !swapped; i++) {
      try {
        fs.renameSync(swapTmp, asarPath);
        swapped = true;
      } catch (err) {
        lockErr = err;
        if (i < 5) await sleep(2000);
      }
    }
    if (!swapped) {
      try {
        fs.rmSync(swapTmp, { force: true });
      } catch {}
      console.error('\n✖ app.asar is locked, host patch not applied (runtime and plugins are in place).');
      console.error(`  rename failed: ${lockErr?.code || ''} ${lockErr?.message || lockErr}`);
      if (isZcodeRunning()) {
        console.error('  ZCode is running (possibly reopened during install): quit it fully and rerun zmod install, or use --force to kill the process and relaunch automatically.');
      } else {
        console.error('  No ZCode process detected but the asar is still locked — likely antivirus/indexer scanning; wait a moment and rerun zmod install.');
      }
      process.exitCode = 2;
      return;
    }
    console.log(`• Written: ${asarPath}`);

    configManager.set('installPath', hostDir);
    if (killed) {
      const exe = findHostExe(hostDir);
      if (exe) {
        launchDetached(exe);
        console.log('• Relaunched ZCode');
      }
    }

    console.log('\n✔ ZMod install complete!');
    console.log('  Launch ZCode and press Ctrl+Shift+M to open the management panel.');
    console.log(`  Restore official: zmod restore (baseline snapshot: ${baseSnapshot})\n`);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}
