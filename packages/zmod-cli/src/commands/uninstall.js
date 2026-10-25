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
    console.log('• 未找到 ZCode 安装目录，跳过 asar 还原（ZMod 补丁如仍在，可用 install --baseline 修复）');
    return 'nohost';
  }
  const asarPath = findAsarInHost(hostDir);
  const hits = findMarkers(asarPath, Object.values(MARKERS));
  if (hits.length === 0) {
    console.log('• asar 已是官方纯净版，无需还原');
    return 'pristine';
  }
  const candidate = resolveBaselineCandidate({
    baseSnapshot: getBaseSnapshotPath(),
    asarPath,
    explicit: opts.baseline,
    globalBaseline: getGlobalBaselinePath(getHostVersion(hostDir, findHostExe))
  });
  if (!candidate) {
    console.warn('⚠ asar 仍是 ZMod 补丁版且无可用基线，无法自动还原官方客户端。');
    console.warn('  重装 ZCode 客户端或用 install --baseline 提供官方原始 app.asar 可恢复。');
    return 'nobaseline';
  }
  console.log(`• 还原官方 asar（来源: ${candidate.label}）…`);
  const swapTmp = `${asarPath}.zmod-restore`;
  fs.copyFileSync(candidate.path, swapTmp);
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(swapTmp, asarPath);
      console.log(`✔ 已还原: ${asarPath}`);
      return 'restored';
    } catch {
      if (i < 2) await sleep(1500);
    }
  }
  try { fs.rmSync(swapTmp, { force: true }); } catch {}
  console.warn(`⚠ 还原失败：${asarPath} 被占用（ZCode 运行中？）。程序文件仍将卸载；`);
  console.warn('  事后可重装 ZCode 客户端或用 install --baseline 恢复官方 asar。');
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
  console.log('\n🧹 [ZMod Uninstall] 清单驱动卸载\n');
  const manifestPath = path.join(REPO_ROOT, MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    console.error(`✖ ${MANIFEST} 不存在：不是安装器受管的安装目录（开发仓库同此）。`);
    process.exit(3);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`• 清单版本: ${manifest.version}（${manifest.files.length} 文件 / ${manifest.dirs.length} 目录）`);

  // 数据目录必须在删除任何清单文件之前解析：定位锚点
  // （packages/zmod-cli/bin/zmod.js）本身就在清单里，删完再查会退到 APPDATA 兜底
  const dataDir = getUserDataDir();
  const keepData = opts.wipeData !== true;
  console.log(keepData ? '• 模式: 保留用户数据（data/）' : '• 模式: 彻底清除（含 data/）');

  const restoreState = await bestEffortRestore(opts);

  const plan = planUninstall(manifest, { keepData });
  let missing = 0;
  for (const rel of plan.files) {
    const p = path.join(REPO_ROOT, ...rel.split('/'));
    try { fs.rmSync(p, { force: true }); } catch { missing++; }
  }
  console.log(`• 已删除清单文件 ${plan.files.length - missing} 条${missing ? `（${missing} 条已不存在或失败）` : ''}`);

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
    console.log('• 已清除数据目录 data/');
  }
  try { fs.rmdirSync(REPO_ROOT); } catch {
    await sleep(600);
    try { fs.rmdirSync(REPO_ROOT); } catch { dirLeft++; }
  }
  console.log(dirLeft ? `• ${dirLeft} 个目录非空或被占用，保留原样` : '• 安装目录已移除');
  console.log('✔ 卸载完成\n');
  if (restoreState === 'nobaseline' || restoreState === 'locked' || restoreState === 'nohost') {
    process.exit(4);
  }
}
