import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateZCode, findAsarInHost, findHostExe } from '../locate.js';
import { findMarkers } from '../lib/asar.js';
import { MARKERS } from '../patches/index.js';
import { resolveBaselineCandidate, getHostVersion, getGlobalBaselinePath } from '../lib/baseline.js';
import { getBaseSnapshotPath, getUserDataDir, getLogsDir } from '../../../zmod-core/src/common/paths.js';
import { sleep } from '../lib/process.js';
import { teeConsoleTo } from './install.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MANIFEST = 'install-manifest.json';
// 卸载执行期间自身正在被使用，由 NSIS 外壳在 ExecWait 返回后清理
const NSIS_OWNED = new Set(['run-install.cmd', 'Uninstall.exe']);

/**
 * 依据清单规划删除动作（纯函数，供单测）。
 * keepData 时 data/ 整体不动（runtime/插件/配置/基线都在里面）；
 * wipeData 时 data/ 一并删除。文件相对路径统一用正斜杠。
 */
export function planUninstall(manifest, { keepData }) {
  const files = manifest.files.filter((f) => !NSIS_OWNED.has(f) && (keepData || !f.startsWith('data/')));
  // dirs 深度浅在前：先删内容再删壳，层层可空删
  const dirs = manifest.dirs
    .filter((d) => keepData || d !== 'data')
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return { files, dirs, wipeData: !keepData };
}

/** 尽力还原官方 asar：补丁版且找得到基线才动作，失败只警告不阻断卸载。
 * @returns {'pristine'|'restored'|'nohost'|'nobaseline'|'locked'} */
async function bestEffortRestore(opts) {
  const hostDir = locateZCode({ explicit: opts.path });
  if (!hostDir) {
    console.log('• ZCode install dir not found, skipping asar restore (if the ZMod patch remains, fix with install --baseline)');
    return 'nohost';
  }
  const asarPath = findAsarInHost(hostDir);
  const hits = findMarkers(asarPath, Object.values(MARKERS));
  if (hits.length === 0) {
    console.log('• asar is already pristine official, no restore needed');
    return 'pristine';
  }
  const candidate = resolveBaselineCandidate({
    baseSnapshot: getBaseSnapshotPath(),
    asarPath,
    explicit: opts.baseline,
    globalBaseline: getGlobalBaselinePath(getHostVersion(hostDir, findHostExe))
  });
  if (!candidate) {
    console.warn('⚠ asar is still ZMod-patched and no usable baseline exists; cannot auto-restore the official client.');
    console.warn('  Reinstall the ZCode client or supply the pristine app.asar via install --baseline to recover.');
    return 'nobaseline';
  }
  console.log(`• Restoring official asar (source: ${candidate.label})...`);
  const swapTmp = `${asarPath}.zmod-restore`;
  fs.copyFileSync(candidate.path, swapTmp);
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(swapTmp, asarPath);
      console.log(`✔ Restored: ${asarPath}`);
      return 'restored';
    } catch {
      if (i < 2) await sleep(1500);
    }
  }
  try { fs.rmSync(swapTmp, { force: true }); } catch {}
  console.warn(`⚠ Restore failed: ${asarPath} is locked (ZCode running?). Program files will still be uninstalled;`);
  console.warn('  afterwards reinstall the ZCode client or use install --baseline to recover the official asar.');
  return 'locked';
}

/**
 * 清单驱动卸载。退出码：0 成功；3 非受管安装（无清单，NSIS 走兜底）；
 * 4 卸载完成但官方客户端未能还原（asar 仍是补丁版，NSIS 弹警告）。
 * 注册表由 NSIS 外壳按保留数据选项处置，本命令不碰注册表。
 */
export async function uninstall(opts = {}) {
  // 先落日志再输出：NSIS ExecWait 下用户看不到控制台，失败只剩日志可查
  try {
    fs.mkdirSync(getLogsDir(), { recursive: true });
    teeConsoleTo(path.join(getLogsDir(), 'uninstall-latest.log'));
  } catch {}
  console.log('\n🧹 [ZMod Uninstall] Manifest-driven uninstall\n');
  const manifestPath = path.join(REPO_ROOT, MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    console.error(`✖ ${MANIFEST} not found: not an installer-managed install directory (dev repo included).`);
    process.exit(3);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`• Manifest version: ${manifest.version} (${manifest.files.length} files / ${manifest.dirs.length} dirs)`);

  // 数据目录必须在删除任何清单文件之前解析：定位锚点
  // （packages/zmod-cli/bin/zmod.js）本身就在清单里，删完再查会退到 APPDATA 兜底
  const dataDir = getUserDataDir();
  const keepData = opts.wipeData !== true;
  console.log(keepData ? '• Mode: keep user data (data/)' : '• Mode: wipe everything (including data/)');

  const restoreState = await bestEffortRestore(opts);

  const plan = planUninstall(manifest, { keepData });
  let missing = 0;
  for (const rel of plan.files) {
    const p = path.join(REPO_ROOT, ...rel.split('/'));
    try { fs.rmSync(p, { force: true }); } catch { missing++; }
  }
  console.log(`• Manifest files deleted: ${plan.files.length - missing}${missing ? ` (${missing} already gone or failed)` : ''}`);

  // 删除后短窗内 Windows 可能仍持有目录句柄（Defender/索引器扫刚删的文件），
  // 失败项延迟重试一轮；仍失败说明非空（用户文件混入），保留
  let left = plan.dirs.map((rel) => path.join(REPO_ROOT, ...rel.split('/')));
  for (let pass = 0; pass < 2 && left.length; pass++) {
    if (pass) await sleep(600);
    left = left.filter((p) => {
      try { fs.rmdirSync(p); return false; } catch { return true; }
    });
  }
  let dirLeft = left.length;
  if (!keepData && fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('• Data directory data/ removed');
  }
  try { fs.rmdirSync(REPO_ROOT); } catch {
    await sleep(600);
    try { fs.rmdirSync(REPO_ROOT); } catch { dirLeft++; }
  }
  console.log(dirLeft ? `• ${dirLeft} dirs non-empty or locked, left as-is` : '• Install directory removed');
  console.log('✔ Uninstall complete\n');
  if (restoreState === 'nobaseline' || restoreState === 'locked' || restoreState === 'nohost') {
    process.exit(4);
  }
}
