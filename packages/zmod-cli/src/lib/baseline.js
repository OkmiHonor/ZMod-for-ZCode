import fs from 'node:fs';
import path from 'node:path';

/**
 * 官方基线（原始 app.asar）解析：安装重装与卸载还原共用的唯一事实源。
 * 候选按优先级排列，data 目录被清空（卸载事故/误删）也不应在补丁版 asar 上死锁。
 * @returns {{path: string, label: string} | null}
 */
export function resolveBaselineCandidate({ baseSnapshot, asarPath, explicit }) {
  const legacyBackup = path.join(path.dirname(asarPath), 'app.asar.backup1');
  const candidates = [
    [baseSnapshot, '基线快照 base/app.asar'],
    [legacyBackup, `旧版备份 ${legacyBackup}`],
    [explicit, `指定基线 ${explicit}`]
  ];
  const hit = candidates.find(([p]) => p && fs.existsSync(p));
  return hit ? { path: hit[0], label: hit[1] } : null;
}

/** 把找到的基线回填为 canonical 快照（base/app.asar），使后续 restore/重装自愈。 */
export function backfillBaseSnapshot(baseSnapshot, source) {
  if (path.resolve(source) === path.resolve(baseSnapshot)) return false;
  fs.mkdirSync(path.dirname(baseSnapshot), { recursive: true });
  const snapTmp = `${baseSnapshot}.tmp`;
  fs.copyFileSync(source, snapTmp);
  fs.renameSync(snapTmp, baseSnapshot);
  return true;
}
