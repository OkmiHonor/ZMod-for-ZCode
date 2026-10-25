import fs from 'node:fs';
import { locateZCode, findAsarInHost, findHostExe } from '../locate.js';
import { resolveBaselineCandidate, getHostVersion, getGlobalBaselinePath, backfillBaseSnapshot } from '../lib/baseline.js';
import { getBaseSnapshotPath } from '../../../zmod-core/src/common/paths.js';
import { isZcodeRunning, killZcode, launchDetached, sleep } from '../lib/process.js';

/**
 * Restore the pristine official client. Source priority:
 * 1. base/app.asar  — snapshot taken at first install (survives client updates)
 * 2. resources/app.asar.backup1 — legacy convention
 */
export async function restore(opts = {}) {
  console.log('\n🧹 [ZMod Restore] 还原官方纯净客户端\n');

  const hostDir = locateZCode({ explicit: opts.path });
  if (!hostDir) {
    console.error('✖ 未找到 ZCode 安装目录（可用 --path 指定）。');
    process.exit(1);
  }
  const asarPath = findAsarInHost(hostDir);

  const hostVersion = getHostVersion(hostDir, findHostExe);
  const candidate = resolveBaselineCandidate({
    baseSnapshot: getBaseSnapshotPath(),
    asarPath,
    globalBaseline: getGlobalBaselinePath(hostVersion)
  });
  if (!candidate) {
    console.error('✖ 找不到任何原始基线（base/app.asar、机器级缓存、app.asar.backup1 均不存在），无法自动还原。');
    process.exit(1);
  }
  const source = candidate.path;
  console.log(`• 还原来源: ${source}`);

  if (opts.force && isZcodeRunning()) {
    console.log('• --force: 结束 ZCode 进程…');
    killZcode();
    await sleep(2000);
  }

  // Evidence-based lock handling: attempt the swap, report only on real failure.
  const swapTmp = `${asarPath}.zmod-restore`;
  fs.copyFileSync(source, swapTmp);
  let swapped = false;
  let lockErr = null;
  for (let i = 0; i < 3 && !swapped; i++) {
    try {
      fs.renameSync(swapTmp, asarPath);
      swapped = true;
    } catch (err) {
      lockErr = err;
      if (i < 2) await sleep(1500);
    }
  }
  if (!swapped) {
    try {
      fs.rmSync(swapTmp, { force: true });
    } catch {}
    console.error(`✖ 还原失败：${asarPath} 被占用（${lockErr?.code || ''} ${lockErr?.message || lockErr}）`);
    if (isZcodeRunning()) {
      console.error('  ZCode 正在运行：请完全退出后重试，或使用 --force。');
    }
    process.exitCode = 2;
    return;
  }
  console.log(`✔ 已还原: ${asarPath}`);
  // 命中机器级缓存/旧备份时回填 data 快照并镜像缓存，让下次 install/restore 完全自愈
  backfillBaseSnapshot(getBaseSnapshotPath(), source, { hostVersion });

  if (opts.force) {
    const exe = findHostExe(hostDir);
    if (exe) {
      launchDetached(exe);
      console.log('• 已重新拉起 ZCode（官方纯净版）');
    }
  }
  console.log('完成。卸载残留清理：可手动删除 ZMod 目录下的 data 子目录。\n');
}
