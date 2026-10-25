/**
 * 市场面板的纯视图合并层：把本地已装插件 defs 与 plugin.listRemote 的
 * registry entries 合并成行视图（installed / update-available / not-installed）。
 *
 * 刻意不 import zmod-sdk：本文件被 renderer/index.js 静态 import，部署后虽然
 * zmod-local://sdk/... 协议 URL 可用，但纯 Node 单测环境里协议 import 不可达。
 * 因此这里内联一个最小 semver 比较（数值逐段 + prerelease），足够市场卡片
 * 的版本状态排序；引擎范围判断也只支持 '>=x.y.z' 与 '*' 两种形态（现网
 * registry 全是 >= 形态）——其余 range（^ ~ 精确、不可解析、版本缺失）一律
 * engineOk=true 放行，交给主进程 install/update 的 checkEngine 硬校验兜底；
 * engine.zcode 范围同样不查（主进程会用 hostVersion 硬校验）。
 */

/** strict semver: major.minor.patch[-prerelease][+build]（+build 不参与比较） */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * 三行 semver 比较（strcmp 语义：-1/0/1）。任一侧不可解析返回 null，
 * 调用方按"不可比 → 不标更新"处理（宁可漏报也不误报降级）。
 * prerelease 遵循 semver 规则：同 x.y.z 下无 prerelease > 有 prerelease。
 */
export function compareSemver(a, b) {
  const ma = String(a ?? '').trim().match(SEMVER_RE);
  const mb = String(b ?? '').trim().match(SEMVER_RE);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  const pa = ma[4] ? ma[4].split('.') : [];
  const pb = mb[4] ? mb[4].split('.') : [];
  if (pa.length === 0 && pb.length === 0) return 0;
  if (pa.length === 0) return 1;
  if (pb.length === 0) return -1;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (pa[i] === undefined) return -1; // 短前缀先行者小
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d) return d < 0 ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1; // 数字段 < 字母数字段
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 简化版 zmod 引擎范围检查（只看 manifest.engine.zmod）。
 * 返回 { ok, reason }；'*'/空/不支持形态/版本不可比/缺省 zmodVersion → ok。
 */
export function evaluateZmodEngine(engine, zmodVersion) {
  const range =
    engine && typeof engine === 'object' && !Array.isArray(engine)
      ? String(engine.zmod ?? '').trim()
      : '';
  if (!range || range === '*') return { ok: true, reason: null };
  if (!range.startsWith('>=')) return { ok: true, reason: null }; // 非受支持形态 → 放行主进程兜底
  const base = range.slice(2).trim();
  if (!zmodVersion) return { ok: true, reason: null }; // 缺省放行（与 mergeMarketView 语义一致）
  const cmp = compareSemver(zmodVersion, base);
  if (cmp === null) return { ok: true, reason: null };
  if (cmp >= 0) return { ok: true, reason: null };
  return { ok: false, reason: `插件需要 ZMod 版本 ${range}，当前为 ${zmodVersion}` };
}

/**
 * 合并本地 defs 与 registry entries 为市场行视图。
 *
 * @param {Array<{id:string,name?:string,version?:string,description?:string}>} localDefs
 *   registry.getAll() 的 definePlugin defs
 * @param {Array<{id:string,version?:string,url?:string,manifest?:object}>} registryPlugins
 *   plugin.listRemote 返回的 plugins 数组
 * @param {{ zmodVersion?: string }} [opts]
 * @returns {{ rows: Array, localOnly: Array }}
 *   rows: 每个 registry entry 一行 { id,name,version,description,category,
 *   permissions,installedVersion,state,engineOk,engineReason,url }
 *   localOnly: 本地有而 registry 没有的 defs（已装 tab 自见，市场 tab 不显示）
 */
export function mergeMarketView(localDefs, registryPlugins, opts = {}) {
  const locals = (Array.isArray(localDefs) ? localDefs : []).filter((d) => d && d.id);
  const entries = Array.isArray(registryPlugins) ? registryPlugins : [];
  const localById = new Map(locals.map((d) => [d.id, d]));
  const registryIds = new Set();

  const rows = [];
  for (const entry of entries) {
    if (!entry || !entry.id) continue;
    registryIds.add(entry.id);
    const manifest =
      entry.manifest && typeof entry.manifest === 'object' && !Array.isArray(entry.manifest)
        ? entry.manifest
        : {};
    const local = localById.get(entry.id);
    const installedVersion = local ? String(local.version || '') : null;
    const registryVersion = String(entry.version || manifest.version || '');
    let state = 'not-installed';
    if (installedVersion) {
      const cmp =
        registryVersion && installedVersion
          ? compareSemver(registryVersion, installedVersion)
          : null;
      // 不可比或 registry 更低（防降级）都按已装处理，只有严格更高才标可更新
      state = cmp !== null && cmp > 0 ? 'update-available' : 'installed';
    }
    const engine = evaluateZmodEngine(manifest.engine, opts.zmodVersion);
    rows.push({
      id: entry.id,
      name: manifest.name || entry.id,
      version: registryVersion,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      category: manifest.category || null,
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      installedVersion,
      state,
      engineOk: engine.ok,
      engineReason: engine.reason,
      url: entry.url || null
    });
  }

  const localOnly = locals.filter((d) => !registryIds.has(d.id));
  return { rows, localOnly };
}
