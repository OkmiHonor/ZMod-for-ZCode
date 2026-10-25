import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { locateZCode, findAsarInHost, findHostExe } from '../locate.js';
import { findMarkers, extractAll, packAndVerify, getUnpackedSet } from '../lib/asar.js';
import { isZcodeRunning, killZcode, launchDetached, sleep } from '../lib/process.js';
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

const VERSION = '2.0.0';
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
    console.log(`• 用户数据已迁移: ${legacy} → ${target}`);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      console.error(`✖ 旧数据目录迁移失败（${err.message}），继续使用: ${legacy}`);
      return;
    }
    try {
      fs.cpSync(legacy, target, { recursive: true });
      fs.rmSync(legacy, { recursive: true, force: true });
      console.log(`• 用户数据已迁移（跨盘复制）: ${legacy} → ${target}`);
    } catch (err2) {
      console.error(`✖ 旧数据目录迁移失败（${err2.message}），继续使用: ${legacy}`);
    }
  }
}

/** Deploy the runtime (main/core/sdk) and official plugins into the user data dir. */
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

  const srcPlugins = path.join(REPO_ROOT, 'plugins');
  if (fs.existsSync(srcPlugins)) {
    const shipped = new Set();
    for (const ent of fs.readdirSync(srcPlugins, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        shipped.add(ent.name);
        copyDir(path.join(srcPlugins, ent.name), path.join(getPluginsDir(), ent.name));
      }
    }
    // Mirror sync: plugins dropped from the release must not linger in
    // existing installs, or removed features keep running after upgrade.
    for (const ent of fs.readdirSync(getPluginsDir(), { withFileTypes: true })) {
      if (ent.isDirectory() && !shipped.has(ent.name)) {
        fs.rmSync(path.join(getPluginsDir(), ent.name), { recursive: true, force: true });
      }
    }
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
    console.error('✖ 未找到 ZCode 安装目录。请用 --path <目录> 指定，或设置 ZCODE_PATH 环境变量。');
    process.exit(1);
  }
  const asarPath = findAsarInHost(hostDir);
  console.log(`• 宿主目录: ${hostDir}`);

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
      console.error(`✖ 检测到旧版 ZMod v1（内联魔改）标记: ${v1Hits.join(', ')}`);
      console.error('  为保护你的生产环境，安装器拒绝处理。请先用 v1 工具链还原官方纯净版再安装。');
      process.exit(1);
    }
    const v2Hits = findMarkers(asarPath, Object.values(MARKERS));
    let pristineSource;
    if (v2Hits.length > 0) {
      if (!fs.existsSync(baseSnapshot)) {
        console.error('✖ 当前 asar 已是 ZMod v2 补丁版，但缺少原始基线快照（base/app.asar），无法安全重装。');
        console.error('  请先还原官方 asar 到 ' + asarPath + ' 后重试。');
        process.exit(1);
      }
      console.log('• 检测到已安装 v2，基于原始基线快照重装');
      pristineSource = baseSnapshot;
    } else {
      pristineSource = asarPath;
      // snapshot the pristine official asar — future reinstalls and `restore` depend on it
      console.log('• 当前为官方纯净版，快照基线到 base/app.asar');
      fs.mkdirSync(path.dirname(baseSnapshot), { recursive: true });
      const snapTmp = `${baseSnapshot}.tmp`;
      fs.copyFileSync(asarPath, snapTmp);
      fs.renameSync(snapTmp, baseSnapshot);
    }

    // ---- 2. Extract + patch ----
    const extractDir = path.join(tmpRoot, 'extract');
    console.log('• 解包官方 asar…');
    const unpackedHint = `${asarPath}.unpacked`;
    await extractAll(pristineSource, extractDir, fs.existsSync(unpackedHint) ? unpackedHint : null);

    const mainPath = path.join(extractDir, 'out', 'main', 'index.js');
    const preloadPath = path.join(extractDir, 'out', 'preload', 'index.cjs');
    const htmlPath = path.join(extractDir, 'out', 'renderer', 'index.html');
    for (const f of [mainPath, preloadPath, htmlPath]) {
      if (!fs.existsSync(f)) {
        console.error(`✖ 宿主结构不符合预期，缺少 ${path.relative(extractDir, f)}`);
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
      `• 补丁: main(head${main.changed ? '✔' : '=0'}+tail) preload${preload.changed ? '✔' : '=0'} renderer${html.changed ? '✔' : '=0'}`
    );

    // ---- 3. Repack + verify ----
    console.log('• 重建 asar（node-pty/ssh2 原生二进制 unpack 校验）…');
    const newAsar = path.join(tmpRoot, 'app.asar.new');
    const unpackedCount = await packAndVerify(extractDir, newAsar, pristineSource);
    console.log(`• unpacked 集合与基线一致: ${unpackedCount} 条`);

    // ---- 4. Deploy runtime + plugins (no client restart needed for this part) ----
    const runtimeDir = deployRuntimeAndPlugins();
    console.log(`• 运行时与插件已部署: ${runtimeDir}`);

    // ---- 5. Swap the asar (evidence-based lock handling: try first) ----
    let killed = false;
    if (opts.force && isZcodeRunning()) {
      console.log('• --force: 结束 ZCode 进程…');
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
      console.error('\n✖ app.asar 被占用，宿主补丁未应用（运行时与插件已就位）。');
      console.error(`  rename 失败: ${lockErr?.code || ''} ${lockErr?.message || lockErr}`);
      if (isZcodeRunning()) {
        console.error('  ZCode 正在运行（可能在安装期间被重新打开）：请完全退出后重跑 zmod install，或使用 --force 自动结束进程并重启。');
      } else {
        console.error('  未检测到 ZCode 进程，asar 仍被占用——可能是杀毒/索引扫描；稍等片刻后重跑 zmod install。');
      }
      process.exitCode = 2;
      return;
    }
    console.log(`• 已写入: ${asarPath}`);

    configManager.set('installPath', hostDir);
    if (killed) {
      const exe = findHostExe(hostDir);
      if (exe) {
        launchDetached(exe);
        console.log('• 已重新拉起 ZCode');
      }
    }

    console.log('\n✔ ZMod v2 安装完成！');
    console.log('  启动 ZCode 后按 Ctrl+Shift+M 打开管理面板。');
    console.log(`  还原官方: zmod restore（基线快照: ${baseSnapshot}）\n`);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}
