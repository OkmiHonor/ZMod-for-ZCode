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
// RPC mount
// ---------------------------------------------------------------------------

/**
 * 主进程插件宿主：装 / 卸 / 更新 / 市场列表，让运行中的客户端不经重启管理插件。
 *
 * @param {{register: (method: string, handler: (params: object) => Promise<any>) => void}} gateway
 * @param {object} [injected] 测试注入点：dataDir / fetchImpl / cloneImpl /
 *   broadcastImpl / sleepImpl / removeDirImpl / resolveSource
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
