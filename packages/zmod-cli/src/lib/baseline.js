import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

/** 机器级基线缓存目录：跨安装目录/卸载存活，按 ZCode 版本锚定文件名。
 * 安装目录内的 data/base 天生脆弱（卸载 wipe、误删、换目录都会丢），
 * 基线一旦丢失，补丁版 asar 就无法安全重装或还原——此缓存是救援通道。 */
export function getGlobalBaselineDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'ZMod', 'bases');
}

export function getGlobalBaselinePath(hostVersion) {
  return hostVersion ? path.join(getGlobalBaselineDir(), `app.asar.${hostVersion}`) : null;
}

let hostVersionCache;
/** 宿主 ZCode.exe 的 ProductVersion；探测失败返回 null（此时全局缓存候选不可用，保守跳过）。 */
export function getHostVersion(hostDir, findHostExe) {
  if (hostVersionCache !== undefined) return hostVersionCache;
  try {
    const exe = findHostExe(hostDir);
    if (!exe) throw new Error('ZCode.exe not found');
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Item -LiteralPath '${exe.Replace ? exe : String(exe).replace(/'/g, "''")}').VersionInfo.ProductVersion"`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
    hostVersionCache = /^\d+(\.\d+)*$/.test(out) ? out : null;
  } catch {
    hostVersionCache = null;
  }
  return hostVersionCache;
}

/**
 * 官方基线（原始 app.asar）解析：安装重装与卸载还原共用的唯一事实源。
 * 候选优先级：data 内快照 → 机器级缓存（版本锚定）→ asar 旁旧备份 → 显式指定。
 * @returns {{path: string, label: string} | null}
 */
export function resolveBaselineCandidate({ baseSnapshot, asarPath, explicit, globalBaseline }) {
  const legacyBackup = path.join(path.dirname(asarPath), 'app.asar.backup1');
  const candidates = [
    [baseSnapshot, '基线快照 base/app.asar'],
    [globalBaseline, `机器级缓存 ${globalBaseline}`],
    [legacyBackup, `旧版备份 ${legacyBackup}`],
    [explicit, `指定基线 ${explicit}`]
  ];
  const hit = candidates.find(([p]) => p && fs.existsSync(p));
  return hit ? { path: hit[0], label: hit[1] } : null;
}

/** 把找到的基线回填为 canonical 快照（base/app.asar），使后续 restore/重装自愈。
 * 同时镜像到机器级缓存（版本锚定），供安装目录被清后的救援。 */
export function backfillBaseSnapshot(baseSnapshot, source, { hostVersion } = {}) {
  let wrote = false;
  if (path.resolve(source) !== path.resolve(baseSnapshot)) {
    fs.mkdirSync(path.dirname(baseSnapshot), { recursive: true });
    const snapTmp = `${baseSnapshot}.tmp`;
    fs.copyFileSync(source, snapTmp);
    fs.renameSync(snapTmp, baseSnapshot);
    wrote = true;
  }
  const globalPath = getGlobalBaselinePath(hostVersion);
  if (globalPath && path.resolve(source) !== path.resolve(globalPath) && fs.existsSync(source)) {
    try {
      fs.mkdirSync(path.dirname(globalPath), { recursive: true });
      const tmp = `${globalPath}.tmp`;
      fs.copyFileSync(source, tmp);
      fs.renameSync(tmp, globalPath);
    } catch { /* 缓存失败不阻断安装/还原 */ }
  }
  return wrote;
}
