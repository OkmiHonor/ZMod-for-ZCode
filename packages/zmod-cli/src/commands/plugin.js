import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getPluginsDir, getUserDataDir } from '../../../zmod-core/src/common/paths.js';
import { REGISTRY_URLS, REGISTRY_URL } from '../../../zmod-core/src/common/constants.js';
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

/** 单源一次 fetch：自管 AbortController 超时（AbortSignal.timeout 在进程退出时有 libuv 断言崩溃，禁用）。 */
async function fetchOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout 15000ms')), 15000);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetchRegistry 用的代理提示：Node fetch 不读系统代理，双源全挂时指路。
 * 已设置 HTTPS_PROXY/HTTP_PROXY（含小写）则不再提示。
 */
function proxyEnvHint() {
  const set = (v) => typeof v === 'string' && v.trim() !== '';
  if (
    set(process.env.HTTPS_PROXY) || set(process.env.https_proxy) ||
    set(process.env.HTTP_PROXY) || set(process.env.http_proxy)
  ) {
    return '';
  }
  return ' (no proxy env detected; set HTTPS_PROXY if you use a system proxy)';
}

/** 双源顺序尝试（GitHub raw 主源 + jsdelivr 镜像），先成功者用；全失败返回 null。 */
async function fetchRegistry() {
  const errors = [];
  for (const url of REGISTRY_URLS) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      errors.push(`${url}: ${err?.message || err}`);
    }
  }
  console.error(`✖ 拉取插件注册表失败（双源均不可达）${proxyEnvHint()}:`);
  for (const e of errors) console.error(`  ${e}`);
  return null;
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout 60000ms')), 60000);
    timer.unref?.();
    let res;
    try {
      res = await fetch(entry.url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
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

/**
 * 插件脚手架文件生成（纯函数，供单测）：返回 { 相对路径: 文件内容 }。
 * index.js 的注释即第三方作者的 ctx 能力速览；test 骨架把批 3 的
 * manifest↔definePlugin 一致性校验带给每个新插件。
 */
export function buildScaffold(id, { zmodRange } = {}) {
  // engine 下限缺省 = 当前 CLI 版本，保证脚手架开箱即与本机 ZMod 兼容
  const engineFloor = zmodRange || `>=${CLI_VERSION}`;
  const manifest = {
    id,
    name: id,
    version: '0.1.0',
    // manifest v2 中 description/author 是必填非空字段，生成占位文案保证开箱可安装
    description: '一句话描述这个插件做什么（改我）',
    author: '你的名字',
    engine: { zmod: engineFloor },
    permissions: [],
    category: 'productivity'
  };

  const indexJs = `// ${id} — 由 \`zmod plugin init\` 生成。源码即产物：ESModule 经 zmod-local://
// 协议直接加载，裸导入 @zmod/sdk 由协议端自动重写，无需任何构建步骤。
import { definePlugin } from '@zmod/sdk';

export default definePlugin({
  id: '${id}',
  name: '${id}',            // 改成用户可读的显示名
  version: '0.1.0',        // 与 manifest.json.version 保持一致
  description: '',         // 一句话说明插件做什么
  author: '',

  // 声明式设置：管理面板自动渲染表单，值自动持久化（secret 类型入加密 Vault）
  // 控件类型：toggle / slider / select / text / password / secret / color
  settings: {},

  /**
   * 插件启动钩子。ctx 能力一览：
   * - ctx.invoke(method, params)  主进程 RPC（vault.get/set、system.openExternal、window.* 等）
   * - ctx.ui                      injectStyle(id, css) / removeStyle(id) / showToast(msg, 'success'|'error'|'info'|'warn')
   * - ctx.events                  全局事件总线 on/off/emit（含 setting:<id>:<key>、plugin:enabled/disabled）
   * - ctx.patcher                 AOP 补丁器 before/after/instead(obj, method, fn)，禁用时自动 unpatchAll
   * - ctx.settings                get(key, fallback) / set(key, val) / onChange(key, fn)（禁用时自动解绑）
   * - ctx.datasources             数据源消费与注册（需 manifest 声明 datasource 权限，否则为 null）
   * - ctx.cleanup(fn)             注册回收逻辑，禁用时 LIFO 执行
   */
  async start(ctx) {
    ctx.ui.showToast('Hello from ${id}!', 'success');
  },

  async stop(ctx) {
    // 停用钩子；ctx.cleanup 注册的逻辑会在此之前 LIFO 自动执行
  }
});
`;

  const readme = `# ${id}

ZMod 插件脚手架（\`zmod plugin init\` 生成）。

## 开发

- 插件根 = 本目录：manifest.json + index.js（ESModule，无需构建步骤）
- 本地调试：把本目录复制（或建链接）到 ZMod 数据目录的 plugins/${id}/，重启客户端加载
- 测试骨架：node --test（默认发现 test/ 下的 *.test.js）

## 打包

zip 的解压根必须直接是 manifest.json 与 index.js（不允许多包一层目录）：

\`\`\`
powershell -Command "Compress-Archive -Path .\\* -DestinationPath ..\\${id}-0.1.0.zip"
\`\`\`

## 安装

- CLI：\`zmod plugin install <本目录 | zip 路径 | git 仓库 URL>\`
- 面板：Ctrl+Shift+M → 插件市场 tab 支持 zip 直链 URL 安装

## 发布

提 PR 到官方仓库 plugins/ 目录，或联系维护者登记 registry 条目。
完整走查见 ZMod 仓库 docs/plugin-author-guide.md。
`;

  const testJs = `// ${id} 自检：manifest.json 与 index.js definePlugin 声明保持一致。
// 运行：node --test（默认发现 test/ 下的 *.test.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

test('manifest.json 与 index.js definePlugin 声明一致', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, '${id}');
  assert.match(manifest.version, /^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$/);

  // 只取 definePlugin( 之后最靠前的 id/version 字面量，避免误配嵌套字段
  const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const slice = source.slice(source.indexOf('definePlugin('));
  const idInCode = slice.match(/\\bid\\s*:\\s*(['"])((?:(?!\\1).)*)\\1/);
  const versionInCode = slice.match(/\\bversion\\s*:\\s*(['"])((?:(?!\\1).)*)\\1/);
  assert.equal(idInCode?.[2], manifest.id, 'definePlugin.id 与 manifest.id 不一致');
  assert.equal(versionInCode?.[2], manifest.version, 'definePlugin.version 与 manifest.version 不一致');
});
`;

  return {
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'index.js': indexJs,
    'README.md': readme,
    [`test/${id}.test.js`]: testJs
  };
}

/** 解析 plugin init 的 --dir 标志。 */
function parseInitFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir') flags.dir = rest[++i];
  }
  return flags;
}

/** zmod plugin init <kebab-id> [--dir <目标目录>]：生成插件脚手架目录。 */
function runPluginInit(id, flags = {}) {
  if (!id) {
    console.error('用法: zmod plugin init <kebab-id> [--dir <目标目录，缺省 ./>]');
    process.exit(1);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    console.error(`✖ 非法插件 id: "${id}"（必须 kebab-case：小写字母/数字，连字符分隔）`);
    process.exit(1);
  }
  const baseDir = path.resolve(flags.dir || '.');
  const pluginDir = path.join(baseDir, id);
  if (fs.existsSync(pluginDir)) {
    console.error(`✖ 目录已存在: ${pluginDir}`);
    process.exit(1);
  }
  const files = buildScaffold(id, { zmodRange: `>=${CLI_VERSION}` });
  fs.mkdirSync(path.join(pluginDir, 'test'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(pluginDir, rel), content, 'utf8');
  }

  console.log(`✔ 插件脚手架已生成: ${pluginDir}`);
  console.log(`  ${id}/`);
  console.log('  ├── manifest.json   v2 清单（name/description/author 记得改成真实信息）');
  console.log('  ├── index.js        definePlugin 入口（注释内含 ctx 能力速览）');
  console.log('  ├── README.md');
  console.log(`  └── test/${id}.test.js`);
  console.log('\n下一步:');
  console.log(`  1. 开发调试: 把 ${id}/ 放入 ZMod 数据目录的 plugins/ 下，重启客户端加载`);
  console.log('  2. 打包安装: 压成 zip（根级 manifest.json + index.js）后 zmod plugin install <zip>，或面板 URL 安装');
  console.log('  3. 推到 GitHub 后可直接安装: zmod plugin install https://github.com/you/' + id + '.git');
  console.log('  发布走查见 docs/plugin-author-guide.md（提 PR 到 plugins/ 或登记 registry 条目）。\n');
}

/**
 * 开发目录判定：cwd 与数据目录同属一个 package.json 根时，视为在 ZMod 开发仓库内
 * 运行——此时 data 会解析到仓库自身的 data/，空列表会误导用户以为插件丢失。
 */
function isRunningInsideDevRepo() {
  const findPkgRoot = (start) => {
    let cur = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
    return null;
  };
  const dataRoot = findPkgRoot(path.dirname(getUserDataDir()));
  if (!dataRoot) return false;
  const cwdRoot = findPkgRoot(process.cwd());
  return cwdRoot != null && path.resolve(cwdRoot) === path.resolve(dataRoot);
}

export async function pluginCommand(subCmd, arg, rest = []) {
  if (subCmd === 'init') {
    runPluginInit(arg, parseInitFlags(rest));
    return;
  }

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
      process.exitCode = 1;
      return;
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
      console.log(`  （无插件 — 运行 zmod install 部署官方插件到 ${getPluginsDir()}）`);
      if (isRunningInsideDevRepo()) {
        console.log('  Development mode: data dir resolved to the repository itself. Run from elsewhere (or set ZMOD_USER_DATA_DIR) to operate the deployed install.');
      }
      console.log();
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

  console.log('未知子命令。支持: list, install, remove, update, search, enable, disable, init');
}
