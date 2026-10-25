import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getPluginsDir, getUserDataDir } from '../../../zmod-core/src/common/paths.js';
import { REGISTRY_URL } from '../../../zmod-core/src/common/constants.js';
import {
  readInstalled,
  getInstalledEntry,
  recordInstalled,
  removeInstalled
} from '../../../zmod-core/src/common/installed.js';
import {
  validateManifestSchema,
  checkEngine,
  compareVersions,
  parseVersion
} from '../../../zmod-sdk/src/manifest.js';
import { configManager } from '../../../zmod-core/src/common/config.js';
import { sleep } from '../lib/process.js';

const { version: CLI_VERSION } = createRequire(import.meta.url)('../../package.json');

function scanInstalled() {
  const dir = getPluginsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifestPath = path.join(dir, ent.name, 'manifest.json');
    let manifest = { id: ent.name, name: ent.name, description: '' };
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
      } catch {}
    }
    out.push({ id: ent.name, ...manifest });
  }
  return out;
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

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Windows 10+/macOS tar 都能解 zip（bsdtar）；显式用 System32 的 tar，
// 避免在 Git Bash 等 MSYS 环境下抓到会把 "C:\" 当远程主机解析的 MSYS tar
function tarBin() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

/**
 * 解压 zip 到 destDir 并返回插件根目录：压缩包常见的单层包裹目录下钻一层。
 * 解压失败直接报错退出。
 */
function extractZip(zipPath, destDir) {
  const res = spawnSync(tarBin(), ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`✖ 解压失败: ${zipPath}`);
    process.exit(1);
  }
  const entries = fs.readdirSync(destDir, { withFileTypes: true });
  return entries.length === 1 && entries[0].isDirectory()
    ? path.join(destDir, entries[0].name)
    : destDir;
}

/**
 * Turn a user-supplied source (local dir / .zip / git URL) into a local plugin
 * directory. Returns { dir, cleanup, source, sourceRef, zipPath } — always call
 * cleanup() when done. source/sourceRef/zipPath 供安装记账使用。
 */
function resolvePluginSource(arg) {
  if (/^https?:\/\//.test(arg)) {
    const url = /\.git$/.test(arg) ? arg : `${arg}.git`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-'));
    const res = spawnSync('git', ['clone', '--depth', '1', '--quiet', url, tmp], { stdio: 'inherit' });
    if (res.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      console.error(`✖ git clone 失败: ${url}`);
      process.exit(1);
    }
    return {
      dir: tmp,
      cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
      source: 'git',
      sourceRef: url,
      zipPath: null
    };
  }
  if (arg.toLowerCase().endsWith('.zip')) {
    const abs = path.resolve(arg);
    if (!fs.existsSync(abs)) {
      console.error(`✖ 文件不存在: ${abs}`);
      process.exit(1);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-'));
    const dir = extractZip(abs, tmp);
    return {
      dir,
      cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
      source: 'zip',
      sourceRef: abs,
      zipPath: abs
    };
  }
  const abs = path.resolve(arg);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error(`✖ 目录不存在: ${abs}`);
    process.exit(1);
  }
  return { dir: abs, cleanup: () => {}, source: 'dir', sourceRef: abs, zipPath: null };
}

/**
 * 删除一个插件目录，失败延迟重试一轮（两轮循环）：删除后短窗内 Windows 可能
 * 仍持有目录句柄（Defender/索引器扫刚删的文件），同 uninstall.js 的目录清理模式。
 * @returns {Promise<boolean>} 最终目录是否已不存在
 */
export async function removeDirWithRetry(dir, { passes = 2, delayMs = 600 } = {}) {
  for (let pass = 0; pass < passes; pass++) {
    if (pass) await sleep(delayMs);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    if (!fs.existsSync(dir)) return true;
  }
  return !fs.existsSync(dir);
}

/**
 * 更新决策（纯函数，供单测）：对比本地条目与 registry，产出每个插件的动作。
 * 非 registry 来源不参与 registry 对比，统一返回 skip（git 由命令层单独克隆检查）。
 *
 * @param {Array<{id: string, source: string, version?: string}>} localEntries
 * @param {{plugins?: Array}} registryJson
 * @returns {Array<{id: string, action: 'latest'|'update'|'skip'|'missing',
 *            reason?: string, targetVersion?: string, entry?: object, localVersion?: string}>}
 */
export function planUpdates(localEntries, registryJson) {
  const registry = Array.isArray(registryJson?.plugins) ? registryJson.plugins : [];
  return localEntries.map((local) => {
    if (local.source !== 'registry') {
      const reason = local.source === 'git'
        ? 'git 来源由 update 命令单独克隆检查，不参与 registry 对比'
        : `来源 "${local.source || 'unknown'}" 不支持自动更新，请手动覆盖或先 remove 再 install`;
      return { id: local.id, action: 'skip', reason, localVersion: local.version || '' };
    }
    const entry = registry.find((p) => p && p.id === local.id);
    if (!entry || !entry.version) {
      return { id: local.id, action: 'missing', reason: 'registry 中不存在该插件', localVersion: local.version || '' };
    }
    if (!parseVersion(entry.version)) {
      return { id: local.id, action: 'skip', reason: `registry 版本号非法: ${entry.version}`, localVersion: local.version || '' };
    }
    if (!local.version || !parseVersion(local.version)) {
      // 本地版本缺失/非法无法对比：按可更新处理，由远端版本覆盖
      return { id: local.id, action: 'update', targetVersion: entry.version, entry, localVersion: local.version || '' };
    }
    const cmp = compareVersions(entry.version, local.version);
    if (cmp > 0) {
      return { id: local.id, action: 'update', targetVersion: entry.version, entry, localVersion: local.version };
    }
    if (cmp === 0) {
      return { id: local.id, action: 'latest', reason: `已是最新（${local.version}）`, localVersion: local.version };
    }
    return {
      id: local.id,
      action: 'skip',
      reason: `registry 版本 (${entry.version}) 低于本地 (${local.version})，跳过以免降级`,
      localVersion: local.version
    };
  });
}

/**
 * 搜索过滤（纯函数，供单测）：关键词匹配 id / manifest.name / manifest.description，
 * 大小写不敏感；无关键词返回全部。
 */
export function filterSearch(registryJson, keyword) {
  const plugins = Array.isArray(registryJson?.plugins) ? registryJson.plugins : [];
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return plugins;
  return plugins.filter((p) =>
    [p?.id, p?.manifest?.name, p?.manifest?.description].some(
      (v) => typeof v === 'string' && v.toLowerCase().includes(kw)
    )
  );
}

async function fetchRegistry() {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`✖ 拉取插件注册表失败（网络问题）: ${REGISTRY_URL}`);
    console.error(`  ${err?.message || err}`);
    return null;
  }
}

/** manifest 校验（schema + engine）：errors 非空打印并退出。 */
function validateOrExit(manifest, label) {
  const schema = validateManifestSchema(manifest);
  for (const w of schema.warnings) console.warn(`⚠ ${label} manifest: ${w}`);
  if (!schema.ok) {
    console.error(`✖ ${label} manifest 校验失败:`);
    for (const e of schema.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const engine = checkEngine(manifest, { zmodVersion: CLI_VERSION });
  if (!engine.ok) {
    console.error(`✖ ${label} 引擎兼容性检查失败:`);
    for (const r of engine.reasons) console.error(`  - ${r}`);
    process.exit(1);
  }
}

/** 本地插件版本：manifest 优先，账本兜底。 */
function localVersionOf(pluginsDir, id, entry) {
  const m = readManifest(path.join(pluginsDir, id));
  return (m && typeof m.version === 'string' && m.version) || entry?.version || '';
}

/** registry 更新：下载 → sha256 校验 → 解压 → 校验 → 换目录 → 记账。 */
async function doRegistryUpdate(id, decision) {
  const entry = decision.entry;
  console.log(`• 下载更新: ${id} ${decision.localVersion || '?'} → ${decision.targetVersion}\n  ${entry.url}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-update-'));
  try {
    const zipPath = path.join(tmp, 'plugin.zip');
    const res = await fetch(entry.url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) {
      console.error(`✖ 下载失败（HTTP ${res.status}）: ${entry.url}`);
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    const shasum = sha256File(zipPath);
    if (entry.shasum && shasum !== entry.shasum) {
      console.error(`✖ sha256 校验不匹配，拒绝安装: ${id}\n  期望 ${entry.shasum}\n  实际 ${shasum}`);
      process.exitCode = 1;
      return;
    }
    // 解到独立子目录，避免 plugin.zip 自身混进插件目录
    const extractDir = path.join(tmp, 'x');
    fs.mkdirSync(extractDir, { recursive: true });
    const extracted = extractZip(zipPath, extractDir);
    const manifest = readManifest(extracted);
    if (!manifest) {
      console.error(`✖ 更新包缺少 manifest.json，拒绝安装: ${id}`);
      process.exitCode = 1;
      return;
    }
    validateOrExit(manifest, `插件 ${id}`);
    const dest = path.join(getPluginsDir(), id);
    if (!(await removeDirWithRetry(dest))) {
      console.error(`✖ 旧插件目录删除失败（被占用？）: ${dest}`);
      process.exitCode = 1;
      return;
    }
    fs.cpSync(extracted, dest, { recursive: true });
    recordInstalled(getUserDataDir(), id, {
      version: manifest.version || decision.targetVersion,
      source: 'registry',
      sourceRef: entry.url,
      shasum: entry.shasum || shasum
    });
    console.log(`✔ 已更新 ${id}: ${decision.localVersion || '?'} → ${manifest.version || decision.targetVersion}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** git 来源更新：克隆 → 对比版本 → 新则同 registry 流程替换（账本记 source:'git'）。 */
async function doGitUpdate(id, sourceRef, localVersion) {
  if (!sourceRef) {
    console.log(`• 跳过 ${id}: 账本缺少 git 来源 URL，请先 remove 后重新 install 以记账`);
    return;
  }
  console.log(`• 检查 git 更新: ${id} ← ${sourceRef}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-update-'));
  try {
    const res = spawnSync('git', ['clone', '--depth', '1', '--quiet', sourceRef, tmp], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`✖ git clone 失败: ${sourceRef}`);
      process.exitCode = 1;
      return;
    }
    const manifest = readManifest(tmp);
    const newV = (manifest && typeof manifest.version === 'string' && manifest.version) || '';
    let isOlder = false;
    if (newV && localVersion && parseVersion(newV) && parseVersion(localVersion)) {
      isOlder = compareVersions(newV, localVersion) <= 0;
    } else {
      isOlder = newV === localVersion; // 版本不可比时退化为字符串相等判断
    }
    if (isOlder) {
      console.log(`• ${id} 已是最新（${localVersion || '未知版本'}）`);
      return;
    }
    if (!manifest) {
      console.error(`✖ 仓库缺少 manifest.json，拒绝更新: ${id}`);
      process.exitCode = 1;
      return;
    }
    validateOrExit(manifest, `插件 ${id}`);
    const dest = path.join(getPluginsDir(), id);
    if (!(await removeDirWithRetry(dest))) {
      console.error(`✖ 旧插件目录删除失败（被占用？）: ${dest}`);
      process.exitCode = 1;
      return;
    }
    fs.cpSync(tmp, dest, { recursive: true });
    recordInstalled(getUserDataDir(), id, { version: newV, source: 'git', sourceRef, shasum: '' });
    console.log(`✔ 已更新 ${id}: ${localVersion || '?'} → ${newV}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runInstall(arg) {
  const src = resolvePluginSource(arg);
  try {
    if (!fs.existsSync(path.join(src.dir, 'index.js'))) {
      console.error('✖ 插件源缺少 index.js（约定：插件根目录必须含 index.js，可选 manifest.json）');
      process.exit(1);
    }
    let manifest = readManifest(src.dir);
    if (!manifest) {
      manifest = { id: path.basename(src.dir) };
      console.warn('⚠ 源缺少/损坏 manifest.json，跳过 schema 校验（用目录名作为插件 id）');
    } else {
      validateOrExit(manifest, '插件');
    }
    const id = manifest.id || path.basename(src.dir);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      console.error(`✖ 非法插件 id: "${id}"（仅允许字母/数字/-/_）`);
      process.exit(1);
    }
    const dest = path.join(getPluginsDir(), id);
    if (fs.existsSync(dest)) {
      console.error(`✖ 插件 "${id}" 已安装（${dest}）。用 zmod plugin remove 后重装，或 zmod plugin update 升级。`);
      process.exit(1);
    }
    fs.mkdirSync(getPluginsDir(), { recursive: true });
    fs.cpSync(src.dir, dest, { recursive: true });
    configManager.setPluginEnabled(id, true);
    recordInstalled(getUserDataDir(), id, {
      version: typeof manifest.version === 'string' ? manifest.version : '',
      source: src.source,
      sourceRef: src.sourceRef,
      shasum: src.source === 'zip' && src.zipPath ? sha256File(src.zipPath) : ''
    });
    console.log(`✔ 插件 "${id}"${manifest.version ? ` v${manifest.version}` : ''} 已安装并启用。`);
    console.log('  重启客户端生效；之后可在面板 (Ctrl+Shift+M) 内即时开关。\n');
  } finally {
    src.cleanup();
  }
}

async function runUpdate(arg) {
  const dataDir = getUserDataDir();
  const ledger = readInstalled(dataDir);
  const pluginsDir = getPluginsDir();

  const targets = [];
  if (arg) {
    const entry = getInstalledEntry(dataDir, arg);
    if (!entry) {
      if (fs.existsSync(path.join(pluginsDir, arg))) {
        console.error(`✖ 插件 "${arg}" 在账本中无记录（老版本安装）。请先 zmod plugin remove ${arg} 再 zmod plugin install 重装一次以记账。`);
      } else {
        console.error(`✖ 插件 "${arg}" 未安装。用 zmod plugin list 查看已装插件。`);
      }
      process.exit(1);
    }
    targets.push({ id: arg, entry });
  } else {
    targets.push(...Object.entries(ledger.plugins).map(([id, entry]) => ({ id, entry })));
  }
  if (targets.length === 0) {
    console.log('• 账本中没有可更新的插件。');
    return;
  }

  // 账本无记录的目录插件（老版本装的）：提示先重装一次以记账
  const untracked = arg
    ? []
    : fs.existsSync(pluginsDir)
      ? fs.readdirSync(pluginsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !(e.name in ledger.plugins))
          .map((e) => e.name)
      : [];

  const manual = targets.filter((t) => ['zip', 'dir', 'builtin'].includes(t.entry.source));
  const gitTargets = targets.filter((t) => t.entry.source === 'git');
  const registryTargets = targets.filter((t) => t.entry.source === 'registry');

  for (const { id, entry } of manual) {
    if (entry.source === 'builtin') {
      console.log(`• 跳过 ${id}: 随 ZMod 基座发布，重跑安装器/zmod install 会重新部署它`);
    } else {
      console.log(`• 跳过 ${id}: 来源 "${entry.source}" 不支持自动更新，请手动覆盖或先 remove 再 install`);
    }
  }
  for (const t of gitTargets) {
    await doGitUpdate(t.id, t.entry.sourceRef, localVersionOf(pluginsDir, t.id, t.entry));
  }
  if (registryTargets.length) {
    const registryJson = await fetchRegistry();
    if (!registryJson) {
      console.error('✖ 无法获取插件注册表，请检查网络后重试。');
      process.exit(1);
    }
    const localEntries = registryTargets.map((t) => ({
      id: t.id,
      source: 'registry',
      version: localVersionOf(pluginsDir, t.id, t.entry)
    }));
    for (const d of planUpdates(localEntries, registryJson)) {
      if (d.action === 'update') {
        await doRegistryUpdate(d.id, d);
      } else {
        console.log(`• ${d.action === 'latest' ? d.id : `跳过 ${d.id}`}: ${d.reason}`);
      }
    }
  }

  if (untracked.length) {
    console.warn(`⚠ 以下插件目录没有账本记录（老版本安装），无法自动更新: ${untracked.join(', ')}`);
    console.warn('  请先 zmod plugin remove <id> 再 zmod plugin install 重装一次以记账。');
  }
}

export async function pluginCommand(subCmd, arg) {
  if (subCmd === 'install') {
    if (!arg) {
      console.error('用法: zmod plugin install <本地目录 | xxx.zip | git-url>');
      process.exit(1);
    }
    await runInstall(arg);
    return;
  }

  if (subCmd === 'remove') {
    if (!arg) {
      console.error('用法: zmod plugin remove <plugin-id>');
      process.exit(1);
    }
    const dir = path.join(getPluginsDir(), arg);
    if (!fs.existsSync(dir)) {
      console.error(`✖ 插件 "${arg}" 未安装（目录不存在: ${dir}）。用 zmod plugin list 查看已装插件。`);
      process.exit(1);
    }
    const dataDir = getUserDataDir();
    const entry = getInstalledEntry(dataDir, arg);
    if (entry && entry.source === 'builtin') {
      console.warn('⚠ 该插件随 ZMod 基座发布，重跑安装器/zmod install 会重新部署它。');
    }
    console.log(`• 删除插件目录: ${dir}`);
    // 目录先删（失败即中止、账本原状保留），成功才动账本，保证 remove 可重试
    if (!(await removeDirWithRetry(dir))) {
      console.error(`✖ 目录删除失败（被占用？）: ${dir}。请关闭占用它的程序后重试。`);
      process.exit(1);
    }
    if (entry) removeInstalled(dataDir, arg);
    configManager.setPluginEnabled(arg, false);
    console.log(`✔ 插件 "${arg}" 已卸载。配置已保留，重装可恢复。\n`);
    return;
  }

  if (subCmd === 'update') {
    await runUpdate(arg || null);
    return;
  }

  if (subCmd === 'search') {
    console.log(`• 拉取插件注册表: ${REGISTRY_URL}`);
    const registryJson = await fetchRegistry();
    if (!registryJson) {
      console.error('✖ 无法获取插件注册表，请检查网络后重试。');
      process.exit(1);
    }
    const hits = filterSearch(registryJson, arg);
    if (hits.length === 0) {
      console.log(arg ? `  （没有匹配 "${arg}" 的插件）` : '  （注册表为空）');
      return;
    }
    console.log(`\n🔎 [ZMod 插件搜索]${arg ? ` "${arg}"` : ''} — ${hits.length} 个结果:\n`);
    for (const p of hits) {
      const m = p.manifest || {};
      const perms = Array.isArray(m.permissions) && m.permissions.length ? m.permissions.join(',') : '-';
      console.log(`  ${p.id}  v${p.version || m.version || '?'}  [${m.category || '-'}]  权限: ${perms}`);
      if (m.description) console.log(`    ${String(m.description).trim()}`);
    }
    console.log('\n  安装: zmod plugin install <本地目录 | .zip | git-url>\n');
    return;
  }

  if (subCmd === 'list' || !subCmd) {
    console.log('\n📦 [ZMod 插件]:\n');
    const plugins = scanInstalled();
    if (plugins.length === 0) {
      console.log(`  （无插件 — 运行 zmod install 部署官方插件到 ${getPluginsDir()}）\n`);
      return;
    }
    for (const p of plugins) {
      const enabled = configManager.isPluginEnabled(p.id);
      console.log(`  ${enabled ? '●' : '○'} [${enabled ? '启用' : '禁用'}] ${p.id.padEnd(18)} v${p.version || '?'} - ${p.description || p.name}`);
    }
    console.log('\n  注：CLI 开关在下次客户端启动时生效；面板内切换为即时生效 (Ctrl+Shift+M)\n');
    return;
  }

  if (subCmd === 'enable' || subCmd === 'disable') {
    if (!arg) {
      console.error(`用法: zmod plugin ${subCmd} <plugin-id>`);
      process.exit(1);
    }
    const installed = scanInstalled().some((p) => p.id === arg);
    if (!installed) {
      console.error(`✖ 插件 "${arg}" 未安装。用 zmod plugin list 查看已装插件。`);
      process.exit(1);
    }
    configManager.setPluginEnabled(arg, subCmd === 'enable');
    console.log(`✔ 插件 "${arg}" 已设为${subCmd === 'enable' ? '启用' : '禁用'}（重启客户端生效）。`);
    return;
  }

  console.log('未知子命令。支持: list, install, remove, update, search, enable, disable');
}
