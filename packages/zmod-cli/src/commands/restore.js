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
  console.log('\n🧹 [ZMod Restore] Restore pristine official client\n');

  const hostDir = locateZCode({ explicit: opts.path });
  if (!hostDir) {
    console.error('✖ ZCode install directory not found (use --path).');
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
    console.error('✖ No pristine baseline found (base/app.asar, machine-level cache and app.asar.backup1 are all missing); cannot auto-restore.');
    process.exit(1);
  }
  const source = candidate.path;
  console.log(`• Restore source: ${source}`);

  if (opts.force && isZcodeRunning()) {
    console.log('• --force: killing ZCode process...');
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
    console.error(`✖ Restore failed: ${asarPath} is locked (${lockErr?.code || ''} ${lockErr?.message || lockErr})`);
    if (isZcodeRunning()) {
      console.error('  ZCode is running: quit it fully and retry, or use --force.');
    }
    process.exitCode = 2;
    return;
  }
  console.log(`✔ Restored: ${asarPath}`);
  // 命中机器级缓存/旧备份时回填 data 快照并镜像缓存，让下次 install/restore 完全自愈
  backfillBaseSnapshot(getBaseSnapshotPath(), source, { hostVersion });

  if (opts.force) {
    const exe = findHostExe(hostDir);
    if (exe) {
      launchDetached(exe);
      console.log('• Relaunched ZCode (pristine official)');
    }
  }
  console.log('Done. To clean uninstall leftovers: manually delete the data subdirectory under the ZMod directory.\n');
}
