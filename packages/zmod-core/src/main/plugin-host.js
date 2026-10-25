import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getUserDataDir } from '../common/paths.js';
import { REGISTRY_URLS } from '../common/constants.js';
import {
  readInstalled,
  getInstalledEntry,
  recordInstalled,
  removeInstalled
} from '../common/installed.js';
import { configManager } from '../common/config.js';

let electron = null;
try {
  electron = await import('electron');
} catch {
  // Not in Electron (unit tests / CLI context)
}
const electronApp = electron?.app ?? electron?.default?.app;
const electronNetFetch = electron?.net?.fetch ?? electron?.default?.net?.fetch;
const electronBrowserWindow = electron?.BrowserWindow ?? electron?.default?.BrowserWindow;

/**
 * manifest 校验模块（zmod-sdk）。部署后的运行时布局是
 * <data>/runtime/{main,common,sdk}/…，sdk 是 main 的兄弟目录（../sdk/manifest.js）；
 * 仓库内开发/单测时 sdk 在跨包相对路径（与 zmod-cli 的 import 模式一致）。
 * 两条路径都不可达则置 null —— install/update 走 fail-closed 拒绝并说明原因。
 */
let sdkManifest = null;
try {
  sdkManifest = await import('../sdk/manifest.js');
} catch {
  // deployed sibling not present (repo/dev context)
}
if (!sdkManifest) {
  try {
    sdkManifest = await import('../../../zmod-sdk/src/manifest.js');
  } catch {
    // neither path reachable — manifest validation unavailable
  }
}
const validateManifestSchema = sdkManifest?.validateManifestSchema ?? null;
const checkEngine = sdkManifest?.checkEngine ?? null;
const compareVersions = sdkManifest?.compareVersions ?? null;
const parseVersion = sdkManifest?.parseVersion ?? null;

export const PLUGIN_CHANGED_CHANNEL = 'zmod:plugin-changed';

const REGISTRY_TTL_MS = 10 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const REMOVE_RETRY_PASSES = 2;
const REMOVE_RETRY_DELAY_MS = 600;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultFetch = electronNetFetch || globalThis.fetch;

// ---------------------------------------------------------------------------
// shared low-level helpers
// ---------------------------------------------------------------------------

/**
 * fetch + 自管 AbortController 超时。禁用 AbortSignal.timeout：
 * 其底层 timer 在进程退出时可能触发 libuv 断言崩溃（unref 不干净）。
 */
function timedFetch(fetchImpl, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  return Promise.resolve(fetchImpl(url, { signal: ctrl.signal })).finally(() => clearTimeout(timer));
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// System32 的 tar（bsdtar）解 zip：避免 Git Bash/MSYS 环境抓到把 "C:\" 当远程
// 主机解析的 MSYS tar —— 与 zmod-cli 的 extractZip 同模式。
function tarBin() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

/** 解压 zip 到 destDir，压缩包常见的单层包裹目录下钻一层。失败抛错（主进程不 exit）。 */
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const res = spawnSync(tarBin(), ['-xf', zipPath, '-C', destDir]);
  if (res.error) throw new Error(`解压失败: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`解压失败 (tar exit ${res.status}): ${zipPath}`);
  const entries = fs.readdirSync(destDir, { withFileTypes: true });
  return entries.length === 1 && entries[0].isDirectory() ? path.join(destDir, entries[0].name) : destDir;
}

/**
 * 删除插件目录，失败延迟重试（两轮）：删除后短窗内 Windows 可能仍持有目录句柄
 * （Defender/索引器扫刚删的文件）—— 与 zmod-cli removeDirWithRetry 同模式。
 */
async function removeDirWithRetry(dir, { passes = REMOVE_RETRY_PASSES, delayMs = REMOVE_RETRY_DELAY_MS, sleepImpl = defaultSleep } = {}) {
  for (let pass = 0; pass < passes; pass++) {
    if (pass) await sleepImpl(delayMs);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    if (!fs.existsSync(dir)) return true;
  }
  return !fs.existsSync(dir);
}

function readManifest(dir) {
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) return null;
  try {
    return JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch {
    return null;
  }
}

function safeTmpKey(str) {
  const key = String(str || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return key || 'plugin';
}

/** 每次安装/更新的暂存根：<data>/tmp/<id>-<ts>/，cleanup 整体回收。 */
function makeHolder(dataDir, key) {
  const root = path.join(dataDir, 'tmp', `${safeTmpKey(key)}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function entryUrlFor(pluginsDir, id, manifest) {
  let mtime = 0;
  try {
    mtime = fs.statSync(path.join(pluginsDir, id, 'index.js')).mtimeMs;
  } catch {}
  const ver = (manifest && typeof manifest.version === 'string' && manifest.version) || '0';
  // ?v= 防渲染层 import() 的模块缓存（resolveHostFile 已验证会 strip query）
  return `zmod-local://plugins/${id}/index.js?v=${ver}-${mtime}`;
}

/**
 * 宿主自身版本锚点：<data>/../package.json（部署后即 ZMod 根包）。
 * 读不到返回 undefined —— engine 声明了 zmod 的插件会 fail-closed 拒装并在 error 里说明。
 */
function readZmodVersion(dataDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(dataDir, '..', 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function hostVersion() {
  try {
    return electronApp?.getVersion?.();
  } catch {
    return undefined;
  }
}

function validateManifestOrThrow(manifest, env) {
  if (!validateManifestSchema || !checkEngine) {
    throw new Error('manifest 校验模块（zmod-sdk）不可达，fail-closed 拒绝安装');
  }
  const schema = validateManifestSchema(manifest);
  if (!schema.ok) {
    throw new Error(`manifest 校验失败: ${schema.errors.join('; ')}`);
  }
  const engine = checkEngine(manifest, env);
  if (!engine.ok) {
    throw new Error(`引擎兼容性检查失败: ${engine.reasons.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// registry（双源 + 磁盘缓存）
// ---------------------------------------------------------------------------

function registryCachePath(dataDir) {
  return path.join(dataDir, 'cache', 'registry.json');
}

function readRegistryCache(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryCachePath(dataDir), 'utf8'));
    if (parsed?.data && Array.isArray(parsed.data.plugins)) return parsed;
  } catch {}
  return null;
}

function writeRegistryCache(dataDir, data) {
  try {
    const cachePath = registryCachePath(dataDir);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf8');
  } catch {}
}

/**
 * 双源顺序 fetch，先成功者用并写入缓存；TTL 内直接用缓存；
 * 双源都失败回退磁盘缓存（stale:true）；全无则 {ok:false}。
 */
async function fetchRegistry(deps, { force = false } = {}) {
  const dataDir = deps.dataDir;
  if (!force) {
    const fresh = readRegistryCache(dataDir);
    if (fresh && Date.now() - (fresh.fetchedAt || 0) < REGISTRY_TTL_MS) {
      return { ok: true, data: fresh.data, stale: false, fromCache: true };
    }
  }
  const errors = [];
  for (const url of REGISTRY_URLS) {
    try {
      const res = await timedFetch(deps.fetchImpl, url, REGISTRY_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || !Array.isArray(data.plugins)) throw new Error('registry 格式异常（缺少 plugins 数组）');
      writeRegistryCache(dataDir, data);
      return { ok: true, data, stale: false };
    } catch (err) {
      errors.push(`${url}: ${err?.message || err}`);
    }
  }
  const stale = readRegistryCache(dataDir);
  if (stale) {
    return { ok: true, data: stale.data, stale: true, error: errors.join('; ') };
  }
  return { ok: false, error: errors.join('; ') };
}

// ---------------------------------------------------------------------------
// source 解析（registry / git / zip → 本地插件目录）
// ---------------------------------------------------------------------------

async function defaultResolveSource(rawSource, deps) {
  if (rawSource.startsWith('registry:')) {
    const id = rawSource.slice('registry:'.length).trim();
    if (!id) throw new Error('registry 来源缺少插件 id');
    const r = await fetchRegistry(deps, { force: true });
    if (!r.ok) throw new Error(`获取注册表失败: ${r.error}`);
    const entry = r.data.plugins.find((p) => p && p.id === id);
    if (!entry || !entry.url) throw new Error(`注册表中不存在该插件: ${id}`);
    let holder = makeHolder(deps.dataDir, id);
    try {
      const zipPath = path.join(holder.root, 'plugin.zip');
      await downloadToFile(deps, entry.url, zipPath);
      const shasum = sha256File(zipPath);
      if (entry.shasum && shasum !== entry.shasum) {
        throw new Error(`sha256 校验不匹配，拒绝安装: 期望 ${entry.shasum}，实际 ${shasum}`);
      }
      const dir = extractZip(zipPath, path.join(holder.root, 'x'));
      assertSourceShape(dir);
      const kept = holder;
      holder = null;
      return { dir, cleanup: kept.cleanup, source: 'registry', sourceRef: entry.url, shasum };
    } finally {
      holder?.cleanup();
    }
  }

  if (rawSource.startsWith('git:')) {
    const url = rawSource.slice('git:'.length).trim();
    if (!/^https?:\/\//.test(url)) throw new Error(`git 来源必须是 http(s) URL: ${url}`);
    let holder = makeHolder(deps.dataDir, safeTmpKey(path.basename(url)) || 'git');
    try {
      const dir = path.join(holder.root, 'repo');
      await deps.cloneImpl(url, dir);
      assertSourceShape(dir);
      const kept = holder;
      holder = null;
      return { dir, cleanup: kept.cleanup, source: 'git', sourceRef: url, shasum: '' };
    } finally {
      holder?.cleanup();
    }
  }

  if (rawSource.startsWith('zip:')) {
    const url = rawSource.slice('zip:'.length).trim();
    if (!/^https?:\/\//.test(url)) throw new Error(`zip 来源必须是 http(s) URL: ${url}`);
    let holder = makeHolder(deps.dataDir, safeTmpKey(path.basename(url)) || 'zip');
    try {
      const zipPath = path.join(holder.root, 'plugin.zip');
      await downloadToFile(deps, url, zipPath);
      const dir = extractZip(zipPath, path.join(holder.root, 'x'));
      assertSourceShape(dir);
      const kept = holder;
      holder = null;
      return { dir, cleanup: kept.cleanup, source: 'zip', sourceRef: url, shasum: sha256File(zipPath) };
    } finally {
      holder?.cleanup();
    }
  }

  throw new Error(`不支持的安装来源: ${rawSource}（支持 registry:<id> | git:<https url> | zip:<http(s) url>）`);
}

function assertSourceShape(dir) {
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    throw new Error('插件源缺少 manifest.json，拒绝安装');
  }
  if (!fs.existsSync(path.join(dir, 'index.js'))) {
    throw new Error('插件源缺少 index.js（渲染层加载器约定入口固定为 index.js）');
  }
}

async function downloadToFile(deps, url, destPath) {
  const res = await timedFetch(deps.fetchImpl, url, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok) throw new Error(`下载失败 (HTTP ${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`下载超过大小上限: ${buf.length} > ${MAX_DOWNLOAD_BYTES} bytes`);
  }
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

/** 默认 git clone（不存在 git 命令时报可读错误）。 */
function defaultClone(url, destDir) {
  const res = spawnSync('git', ['clone', '--depth', '1', '--quiet', url, destDir]);
  if (res.error) throw new Error(`git 不可用: ${res.error.message}（请确认已安装 Git）`);
  if (res.status !== 0) throw new Error(`git clone 失败 (exit ${res.status}): ${url}`);
}

/**
 * 校验 + 落盘 + 记账 + 广播。install 与 update 共用的核心段：
 * - mode 'install'：目标已存在则拒绝
 * - mode 'update'：先删旧目录（两轮重试）再铺新
 * 返回 { id, version }；失败抛错（调用方负责 cleanup 与 ok:false 包装）。
 */
async function materializeInstalled(deps, src, { mode }) {
  const manifest = readManifest(src.dir);
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest.json 缺失或损坏，拒绝安装');
  }
  validateManifestOrThrow(manifest, {
    zmodVersion: readZmodVersion(deps.dataDir),
    hostVersion: hostVersion()
  });
  const id = manifest.id;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`非法插件 id: ${JSON.stringify(id)}`);
  }
  const pluginsDir = deps.pluginsDir;
  const dest = path.join(pluginsDir, id);

  if (mode === 'install') {
    if (fs.existsSync(dest)) {
      throw new Error(`已安装,请先移除或使用更新: ${id}`);
    }
  } else {
    const replaced = await deps.removeDirImpl(dest);
    if (!replaced) throw new Error(`旧插件目录删除失败（被占用？）: ${dest}`);
  }

  suppressInstallTarget(id); // 自写忽略：RPC 路径自行广播，目录监视不重复处理
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.cpSync(src.dir, dest, { recursive: true });
  recordInstalled(deps.dataDir, id, {
    version: typeof manifest.version === 'string' ? manifest.version : '',
    source: src.source,
    sourceRef: src.sourceRef || '',
    shasum: src.shasum || ''
  });
  configManager.setPluginEnabled(id, true);
  deps.broadcastImpl({
    action: mode === 'update' ? 'updated' : 'installed',
    id,
    entryUrl: entryUrlFor(pluginsDir, id, manifest),
    manifest
  });
  return { id, version: typeof manifest.version === 'string' ? manifest.version : '' };
}

// ---------------------------------------------------------------------------
// plugins 目录监视（把插件文件夹或 zip 拖进 <data>/plugins 即装即热载）
// ---------------------------------------------------------------------------

const WATCH_DEBOUNCE_MS = 500;
const WATCH_SUPPRESS_MS = 3000;
const WATCH_RETRY_LIMIT = 10;

/**
 * 目录监视单例状态：
 * - pending：按目标（plugins 下第一级条目名）合并抖动事件，500ms 稳定后处理一次；
 * - suppress：RPC install/update/remove 的自写目标窗口，命中即跳过（它们已自行广播）；
 * - known：已知插件目录快照（启动扫描 + 每次变更后更新），驱动"目录消失"判定；
 * - retries：目标"未就绪"（大目录/大 zip 拷贝进行中）的顺延重试计数。
 */
const dirWatch = {
  active: false,
  watcher: null,
  dataDir: null,
  pluginsDir: null,
  pending: new Map(),
  retries: new Map(),
  suppress: new Map(),
  known: new Set(),
  broadcastImpl: () => {},
  nowImpl: () => Date.now(),
  debounceMs: WATCH_DEBOUNCE_MS,
  retryLimit: WATCH_RETRY_LIMIT
};

function warnWatch(msg) {
  console.warn(`[ZMod:PluginWatch] ${msg}`);
}

/** RPC install/update/remove 落盘前登记：窗口内的监视事件视为宿主自写，跳过处理。 */
function suppressInstallTarget(id) {
  if (typeof id === 'string' && id) {
    dirWatch.suppress.set(id, dirWatch.nowImpl() + WATCH_SUPPRESS_MS);
  }
}

/** 已知插件快照：盘上有 index.js 的目录 ∪ 账本 id（覆盖手动删目录前的历史安装）。 */
function scanKnownPlugins(pluginsDir, dataDir) {
  const known = new Set();
  try {
    for (const e of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(pluginsDir, e.name, 'index.js'))) {
        known.add(e.name);
      }
    }
  } catch {}
  try {
    for (const id of Object.keys(readInstalled(dataDir).plugins)) known.add(id);
  } catch {}
  return known;
}

/** fs.watch 原始事件入口：提取目标并按 500ms 窗口合并抖动。 */
function onWatchEvent(_eventType, filename) {
  const st = dirWatch;
  try {
    if (!filename) return;
    const target = String(filename).replace(/\\/g, '/').split('/')[0];
    if (!target || target.startsWith('.')) return;
    if (st.pending.has(target)) return; // 窗口内同目标事件合并
    st.retries.delete(target);
    const t = setTimeout(() => {
      st.pending.delete(target);
      void processWatchTarget(target);
    }, st.debounceMs);
    t.unref?.();
    st.pending.set(target, t);
  } catch (err) {
    warnWatch(`事件入队失败: ${err?.message || err}`);
  }
}

/** 事件稳定后仍未就绪（拷贝进行中）→ 有限次顺延，事件停了也不会漏装。 */
function rescheduleTarget(target) {
  const st = dirWatch;
  const n = (st.retries.get(target) || 0) + 1;
  if (n > st.retryLimit) {
    st.retries.delete(target);
    warnWatch(`${target} 持续未就绪，放弃本次监视（等待下一次事件触发）`);
    return;
  }
  st.retries.set(target, n);
  const t = setTimeout(() => {
    st.pending.delete(target);
    void processWatchTarget(target);
  }, st.debounceMs);
  t.unref?.();
  st.pending.set(target, t);
}

/**
 * 目标稳定后的分派：自写窗口 → zip 投放 / 目录投放 / 目录消失。
 * 所有分支自吞异常（主进程常驻，监视失败只 warn 不炸）。
 */
async function processWatchTarget(target) {
  const st = dirWatch;
  if (!st.active) return;
  try {
    const until = st.suppress.get(target);
    if (until !== undefined) {
      if (st.nowImpl() < until) {
        // 自写窗口内不处理，但同步快照使 known 与盘上实况一致
        if (fs.existsSync(path.join(st.pluginsDir, target))) st.known.add(target);
        else st.known.delete(target);
        return;
      }
      st.suppress.delete(target);
    }
    const full = path.join(st.pluginsDir, target);
    let stat = null;
    try { stat = fs.statSync(full); } catch {}
    if (!stat) {
      handleDisappeared(target);
      return;
    }
    if (/\.zip$/i.test(target)) {
      if (stat.isFile()) handleZipDrop(target, full);
      return;
    }
    if (!stat.isDirectory()) return;
    handleDirDrop(target, full);
  } catch (err) {
    warnWatch(`处理事件失败 ${target}: ${err?.message || err}`);
  }
}

/** 目录投放：manifest schema + engine 校验 → 无记录则记账广播 installed，有记录则刷新广播 updated。 */
function handleDirDrop(dirname, full) {
  const st = dirWatch;
  if (!fs.existsSync(path.join(full, 'manifest.json')) || !fs.existsSync(path.join(full, 'index.js'))) {
    rescheduleTarget(dirname);
    return;
  }
  const manifest = readManifest(full);
  if (!manifest || typeof manifest !== 'object') {
    warnWatch(`目录 ${dirname} 的 manifest.json 无法解析，忽略`);
    return;
  }
  const schema = validateManifestSchema?.(manifest);
  if (!schema || !schema.ok) {
    warnWatch(`目录 ${dirname} manifest 校验失败，忽略: ${schema ? schema.errors.join('; ') : '校验模块不可达'}`);
    return;
  }
  const engine = checkEngine?.(manifest, {
    zmodVersion: readZmodVersion(st.dataDir),
    hostVersion: hostVersion()
  });
  if (!engine || !engine.ok) {
    warnWatch(`目录 ${dirname} 引擎不兼容，忽略: ${engine ? engine.reasons.join('; ') : '校验模块不可达'}`);
    return;
  }
  const id = manifest.id;
  if (id !== dirname) {
    // 渲染层 discover 以目录名为插件 id，目录名与 manifest.id 不一致必然装载错位
    warnWatch(`目录名 (${dirname}) 与 manifest.id (${id}) 不一致，忽略`);
    return;
  }
  const entry = getInstalledEntry(st.dataDir, id);
  if (entry) {
    // 升级/内容刷新：目录内容已在位，只刷新账本并广播 updated（保留原 source 与 installedAt）
    recordInstalled(st.dataDir, id, {
      ...entry,
      version: typeof manifest.version === 'string' ? manifest.version : entry.version,
      installedAt: entry.installedAt
    });
    st.known.add(id);
    st.broadcastImpl({
      action: 'updated',
      id,
      entryUrl: entryUrlFor(st.pluginsDir, id, manifest),
      manifest
    });
    return;
  }
  recordInstalled(st.dataDir, id, {
    version: typeof manifest.version === 'string' ? manifest.version : '',
    source: 'dir',
    sourceRef: `watch:${dirname}`,
    shasum: ''
  });
  configManager.setPluginEnabled(id, true);
  st.known.add(id);
  st.broadcastImpl({
    action: 'installed',
    id,
    entryUrl: entryUrlFor(st.pluginsDir, id, manifest),
    manifest
  });
}

/** zip 投放：解压 → 校验 → 落盘 → 删 zip（安装成功即收）→ 记账广播；失败保留原 zip 供用户自查。 */
function handleZipDrop(filename, full) {
  const st = dirWatch;
  const holder = makeHolder(st.dataDir, safeTmpKey(path.basename(filename)));
  try {
    let dir;
    try {
      dir = extractZip(full, path.join(holder.root, 'x'));
    } catch {
      rescheduleTarget(filename); // zip 可能仍在拷贝中
      return;
    }
    if (!fs.existsSync(path.join(dir, 'manifest.json')) || !fs.existsSync(path.join(dir, 'index.js'))) {
      warnWatch(`zip ${filename} 缺少 manifest.json/index.js，不安装（保留原文件）`);
      return;
    }
    const manifest = readManifest(dir);
    if (!manifest || typeof manifest !== 'object') {
      warnWatch(`zip ${filename} 的 manifest.json 无法解析，不安装（保留原文件）`);
      return;
    }
    const schema = validateManifestSchema?.(manifest);
    if (!schema || !schema.ok) {
      warnWatch(`zip ${filename} manifest 校验失败，不安装（保留原文件）: ${schema ? schema.errors.join('; ') : '校验模块不可达'}`);
      return;
    }
    const engine = checkEngine?.(manifest, {
      zmodVersion: readZmodVersion(st.dataDir),
      hostVersion: hostVersion()
    });
    if (!engine || !engine.ok) {
      warnWatch(`zip ${filename} 引擎不兼容，不安装（保留原文件）: ${engine ? engine.reasons.join('; ') : '校验模块不可达'}`);
      return;
    }
    const id = manifest.id;
    const dest = path.join(st.pluginsDir, id);
    if (fs.existsSync(dest)) {
      warnWatch(`zip ${filename} 的插件 ${id} 已存在，视为无效投放（请先移除再投放）`);
      return;
    }
    const shasum = sha256File(full);
    suppressInstallTarget(id); // 自写忽略：落盘事件不重复处理
    fs.mkdirSync(st.pluginsDir, { recursive: true });
    fs.cpSync(dir, dest, { recursive: true });
    try {
      fs.rmSync(full, { force: true });
    } catch (err) {
      warnWatch(`清理投放的 zip 失败: ${err?.message || err}`);
    }
    recordInstalled(st.dataDir, id, {
      version: typeof manifest.version === 'string' ? manifest.version : '',
      source: 'zip',
      sourceRef: `watch:${filename}`,
      shasum
    });
    configManager.setPluginEnabled(id, true);
    st.known.add(id);
    st.broadcastImpl({
      action: 'installed',
      id,
      entryUrl: entryUrlFor(st.pluginsDir, id, manifest),
      manifest
    });
  } finally {
    holder.cleanup();
  }
}

/** 目录消失：仅对已知插件（快照 ∪ 账本）生效，清账本 + enabled 键并广播 removed。 */
function handleDisappeared(target) {
  const st = dirWatch;
  if (!st.known.has(target)) return false;
  st.known.delete(target);
  if (getInstalledEntry(st.dataDir, target)) removeInstalled(st.dataDir, target);
  try { configManager.deletePluginEnabled(target); } catch {}
  st.broadcastImpl({ action: 'removed', id: target, entryUrl: null, manifest: null });
  return true;
}

/** 测试/诊断辅助：立即跑完当前全部待处理目标（含重试链），返回全部处理完成。 */
async function flushPending() {
  const st = dirWatch;
  for (let i = 0; i < 50 && st.pending.size > 0; i++) {
    for (const target of [...st.pending.keys()]) {
      const t = st.pending.get(target);
      clearTimeout(t);
      st.pending.delete(target);
      await processWatchTarget(target);
    }
  }
}

function defaultWatchImpl(dir, opts) {
  return fs.watch(dir, opts);
}

/**
 * 启动 plugins 目录监视（单例防重入）。目录不存在先建；recursive 子目录事件
 * 依赖平台支持（Windows 原生支持）。监视器 unref：不阻塞测试/CLI 进程退出。
 * @param {{
 *   dataDir?: string,
 *   watchImpl?: (dir: string, opts: object) => object,
 *   broadcastImpl?: (payload: object) => void,
 *   nowImpl?: () => number,
 *   debounceMs?: number,
 *   retryLimit?: number
 * }} [opts]
 * @returns {boolean} 是否真正启动（已在运行则 false）
 */
export function startPluginDirWatch(opts = {}) {
  const st = dirWatch;
  if (st.active) return false;
  const dataDir = path.resolve(opts.dataDir || getUserDataDir());
  const pluginsDir = path.join(dataDir, 'plugins');
  try {
    fs.mkdirSync(pluginsDir, { recursive: true });
  } catch (err) {
    warnWatch(`无法创建插件目录，监视未启动: ${err?.message || err}`);
    return false;
  }
  st.dataDir = dataDir;
  st.pluginsDir = pluginsDir;
  st.known = scanKnownPlugins(pluginsDir, dataDir);
  st.suppress.clear();
  st.pending.clear();
  st.retries.clear();
  st.broadcastImpl = opts.broadcastImpl || (() => {});
  if (typeof opts.nowImpl === 'function') st.nowImpl = opts.nowImpl;
  st.debounceMs = Number(opts.debounceMs) || WATCH_DEBOUNCE_MS;
  st.retryLimit = Number(opts.retryLimit) || WATCH_RETRY_LIMIT;
  try {
    const watcher = (opts.watchImpl || defaultWatchImpl)(pluginsDir, { recursive: true });
    watcher.on('change', (eventType, filename) => onWatchEvent(eventType, filename));
    watcher.on('error', (err) => {
      // 目录被删 / 盘符失联等：重置实例允许重建（下次 registerPluginHost 或显式调用）
      warnWatch(`监视器错误，重置: ${err?.message || err}`);
      try { watcher.close?.(); } catch {}
      if (st.watcher === watcher) st.watcher = null;
      st.active = false;
      for (const t of st.pending.values()) clearTimeout(t);
      st.pending.clear();
      st.retries.clear();
    });
    watcher.unref?.();
    st.watcher = watcher;
    st.active = true;
    return true;
  } catch (err) {
    warnWatch(`fs.watch 启动失败: ${err?.message || err}`);
    st.watcher = null;
    st.active = false;
    return false;
  }
}

/** 仅供单测：驱动事件 / 检查与重置监视内部状态。 */
export const __pluginWatchTestHooks = {
  state: dirWatch,
  onWatchEvent,
  processWatchTarget,
  flushPending,
  suppressInstallTarget,
  scanKnownPlugins,
  resetForTest() {
    const st = dirWatch;
    try { st.watcher?.close?.(); } catch {}
    for (const t of st.pending.values()) clearTimeout(t);
    st.active = false;
    st.watcher = null;
    st.pending.clear();
    st.retries.clear();
    st.suppress.clear();
    st.known.clear();
    st.nowImpl = () => Date.now();
  }
};

// ---------------------------------------------------------------------------
// RPC mount
// ---------------------------------------------------------------------------

/**
 * 主进程插件宿主：装 / 卸 / 更新 / 市场列表，让运行中的客户端不经重启管理插件。
 *
 * @param {{register: (method: string, handler: (params: object) => Promise<any>) => void}} gateway
 * @param {object} [injected] 测试注入点：dataDir / fetchImpl / cloneImpl /
 *   broadcastImpl / sleepImpl / removeDirImpl / resolveSource /
 *   watchImpl（注入即拉起目录监视，配合 nowImpl / watchDebounceMs 可离线测 watch 管线）
 */
export function registerPluginHost(gateway, injected = {}) {
  const deps = {
    dataDir: null, // null → 每次调用时取 getUserDataDir()（跟随环境变量与部署布局）
    fetchImpl: defaultFetch,
    cloneImpl: defaultClone,
    broadcastImpl: defaultBroadcast,
    sleepImpl: defaultSleep,
    resolveSource: null,
    ...injected
  };
  // dataDir 之外的派生路径随 dataDir 解析，统一收敛到这里
  const ctx = () => {
    const dataDir = path.resolve(deps.dataDir || getUserDataDir());
    return {
      dataDir,
      pluginsDir: path.join(dataDir, 'plugins'),
      fetchRegistry: (opts) => fetchRegistry({ ...deps, dataDir }, opts)
    };
  };

  function defaultBroadcast(payload) {
    if (!electronBrowserWindow) return;
    for (const w of electronBrowserWindow.getAllWindows()) {
      try {
        w.webContents?.send?.(PLUGIN_CHANGED_CHANNEL, payload);
      } catch {}
    }
  }
  // 注入的 broadcastImpl 优先；未注入且在非 Electron 环境则退化为 no-op
  deps.broadcastImpl = injected.broadcastImpl || defaultBroadcast;
  deps.cloneImpl = injected.cloneImpl || defaultClone;
  deps.removeDirImpl = injected.removeDirImpl ||
    ((dir) => removeDirWithRetry(dir, { sleepImpl: deps.sleepImpl }));

  // ---- 市场列表（双源 + TTL 缓存 + stale 回退）----
  gateway.register('plugin.listRemote', async () => {
    const c = ctx();
    try {
      const r = await c.fetchRegistry({ force: false });
      if (!r.ok) return { ok: false, plugins: [], stale: false, error: r.error };
      const out = { ok: true, plugins: r.data.plugins, stale: !!r.stale };
      if (r.error) out.error = r.error;
      return out;
    } catch (err) {
      return { ok: false, plugins: [], stale: false, error: String(err?.message || err) };
    }
  });

  // ---- 安装 ----
  gateway.register('plugin.install', async ({ source } = {}) => {
    const raw = String(source || '').trim();
    if (!raw) return { ok: false, error: '缺少 source 参数（registry:<id> | git:<https url> | zip:<http(s) url>）' };
    const c = ctx();
    const d = { ...deps, ...c };
    let src = null;
    try {
      src = deps.resolveSource ? await deps.resolveSource(raw, d) : await defaultResolveSource(raw, d);
      const { id, version } = await materializeInstalled(d, src, { mode: 'install' });
      return { ok: true, id, ...(version ? { version } : {}) };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    } finally {
      try { src?.cleanup?.(); } catch {}
    }
  });

  // ---- 卸载（停用由 renderer 响应广播处理，主进程不碰渲染层状态）----
  gateway.register('plugin.remove', async ({ id } = {}) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id || ''))) {
      return { ok: false, error: `非法插件 id: ${JSON.stringify(id)}` };
    }
    const c = ctx();
    const dest = path.join(c.pluginsDir, id);
    if (!fs.existsSync(dest)) return { ok: false, error: `插件未安装: ${id}` };
    suppressInstallTarget(id); // 自删：目录监视不重复广播 removed
    const removed = await deps.removeDirImpl(dest);
    if (!removed) return { ok: false, error: `目录删除失败（被占用？）: ${dest}` };
    removeInstalled(c.dataDir, id);
    // 移除 = 清掉 enabled 键（重装默认启用）；"关闭但保留" 是 enabled:false，不走这里
    configManager.deletePluginEnabled(id);
    deps.broadcastImpl({ action: 'removed', id, entryUrl: null, manifest: null });
    return { ok: true };
  });

  // ---- 更新（registry 强刷对比；git 克隆对比；zip/dir 拒绝）----
  gateway.register('plugin.update', async ({ id } = {}) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id || ''))) {
      return { ok: false, error: `非法插件 id: ${JSON.stringify(id)}` };
    }
    const c = ctx();
    const d = { ...deps, ...c };
    const dest = path.join(c.pluginsDir, id);
    if (!fs.existsSync(dest)) return { ok: false, error: `插件未安装: ${id}` };
    const ledgerEntry = getInstalledEntry(c.dataDir, id);
    if (!ledgerEntry) {
      return { ok: false, error: `账本中无该插件的记录，请先移除再安装一次以记账: ${id}` };
    }
    const localManifest = readManifest(dest);
    const localVersion =
      (localManifest && typeof localManifest.version === 'string' && localManifest.version) ||
      ledgerEntry.version || '';

    if (ledgerEntry.source === 'zip' || ledgerEntry.source === 'dir' || ledgerEntry.source === 'builtin') {
      return { ok: false, error: '该来源不支持自动更新' };
    }

    try {
      if (ledgerEntry.source === 'registry') {
        const r = await c.fetchRegistry({ force: true });
        if (!r.ok) return { ok: false, error: `获取注册表失败: ${r.error}` };
        const entry = r.data.plugins.find((p) => p && p.id === id);
        if (!entry || !entry.url) return { ok: false, error: `注册表中不存在该插件: ${id}` };
        if (!entry.version || (parseVersion && !parseVersion(entry.version))) {
          return { ok: false, error: `注册表版本号非法: ${JSON.stringify(entry?.version)}` };
        }
        if (localVersion && parseVersion && parseVersion(localVersion)) {
          const cmp = compareVersions(entry.version, localVersion);
          if (cmp === 0) return { ok: true, updated: false, version: localVersion };
          if (cmp < 0) {
            return { ok: false, error: `注册表版本 (${entry.version}) 低于本地 (${localVersion})，拒绝降级` };
          }
        }
        const holder = makeHolder(c.dataDir, id);
        try {
          const zipPath = path.join(holder.root, 'plugin.zip');
          await downloadToFile(d, entry.url, zipPath);
          const shasum = sha256File(zipPath);
          if (entry.shasum && shasum !== entry.shasum) {
            throw new Error(`sha256 校验不匹配，拒绝安装: 期望 ${entry.shasum}，实际 ${shasum}`);
          }
          const dir = extractZip(zipPath, path.join(holder.root, 'x'));
          assertSourceShape(dir);
          const { version } = await materializeInstalled(d, {
            dir, cleanup: holder.cleanup, source: 'registry', sourceRef: entry.url, shasum
          }, { mode: 'update' });
          return { ok: true, updated: true, ...(version ? { version } : {}) };
        } finally {
          holder.cleanup();
        }
      }

      if (ledgerEntry.source === 'git') {
        const sourceRef = ledgerEntry.sourceRef;
        if (!sourceRef) {
          return { ok: false, error: '账本缺少 git 来源 URL，请先移除后重新安装一次以记账' };
        }
        const holder = makeHolder(c.dataDir, id);
        try {
          const dir = path.join(holder.root, 'repo');
          await d.cloneImpl(sourceRef, dir);
          const newManifest = readManifest(dir);
          const newV = (newManifest && typeof newManifest.version === 'string' && newManifest.version) || '';
          const comparable =
            newV && localVersion && parseVersion && parseVersion(newV) && parseVersion(localVersion);
          const isOlder = comparable
            ? compareVersions(newV, localVersion) <= 0
            : newV === localVersion; // 版本不可比时退化为字符串相等判断（CLI 同模式）
          if (isOlder) return { ok: true, updated: false, ...(localVersion ? { version: localVersion } : {}) };
          assertSourceShape(dir);
          const { version } = await materializeInstalled(d, {
            dir, cleanup: holder.cleanup, source: 'git', sourceRef, shasum: ''
          }, { mode: 'update' });
          return { ok: true, updated: true, ...(version ? { version } : {}) };
        } finally {
          holder.cleanup();
        }
      }

      return { ok: false, error: '该来源不支持自动更新' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  // ---- plugins 目录监视（拖入目录/zip 即装即热载）----
  // 仅真实 Electron 主进程自动启动（或显式注入 watchImpl）；单测/CLI 不拉起真实 fs.watch。
  if (electronApp || injected.watchImpl) {
    startPluginDirWatch({
      dataDir: deps.dataDir || undefined,
      watchImpl: injected.watchImpl,
      broadcastImpl: deps.broadcastImpl,
      nowImpl: injected.nowImpl,
      debounceMs: injected.watchDebounceMs
    });
  }
}

/**
 * 基座随发插件记账为 builtin（面板按 installed.source==='builtin' 识别）。
 * 由安装器（deployRuntimeAndPlugins）在铺设 plugins/ 目录后调用。
 * @returns {string[]} 成功记账的插件 id
 */
export function writeBuiltinRecords(dataDir, pluginIds) {
  const recorded = [];
  for (const id of pluginIds || []) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) continue;
    if (!fs.existsSync(path.join(dataDir, 'plugins', id))) continue; // 目录缺失的 id 跳过
    try {
      const manifest = readManifest(path.join(dataDir, 'plugins', id));
      const version =
        manifest && typeof manifest.version === 'string' ? manifest.version : '';
      recordInstalled(dataDir, id, { version, source: 'builtin', sourceRef: '', shasum: '' });
      recorded.push(id);
    } catch (err) {
      // reached from the CLI installer (writeBuiltinRecords is called by
      // zmod install) — keep console output ASCII for GBK-safe detail pages
      console.warn(`[ZMod:PluginHost] builtin ledger update failed ${id}: ${err?.message || err}`);
    }
  }
  return recorded;
}
