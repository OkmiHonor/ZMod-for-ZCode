import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// ---- 隔离数据目录（config/installed/cache 全部跟随 ZMOD_USER_DATA_DIR）----
// root/data 为数据目录；root/package.json 作为 zmodVersion 的根包版本锚点
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-host-'));
const dataRoot = path.join(root, 'data');
fs.mkdirSync(dataRoot, { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0-beta' }), 'utf8');
process.env.ZMOD_USER_DATA_DIR = dataRoot;

const { registerPluginHost, writeBuiltinRecords, PLUGIN_CHANGED_CHANNEL } = await import(
  '../src/main/plugin-host.js'
);
const { recordInstalled, readInstalled, getInstalledEntry } = await import(
  '../src/common/installed.js'
);
const { configManager } = await import('../src/common/config.js');

const REGISTRY_PRIMARY = 'raw.githubusercontent.com';
const REGISTRY_MIRROR = 'cdn.jsdelivr.net';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeFixturePlugin(dir, { id = 'demo-plugin', version = '1.1.0', engine } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default {};\n');
  const manifest = {
    id,
    name: `Fixture ${id}`,
    version,
    description: 'fixture 插件',
    author: 'test'
  };
  if (engine) manifest.engine = engine;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return manifest;
}

function tarBin() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

/** 用系统 tar 打一个真实 zip（单层包裹目录）。GNU tar 不支持 zip 时返回 null。 */
function makeZip(srcDir) {
  const zipPath = `${srcDir}.zip`;
  try {
    execFileSync(tarBin(), ['-a', '-cf', zipPath, '-C', path.dirname(srcDir), path.basename(srcDir)]);
  } catch {
    return null;
  }
  return fs.readFileSync(zipPath);
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200 });
}

function binResponse(buf) {
  return new Response(buf, { status: 200 });
}

/** 按 URL 子串路由的 fetch mock，未命中直接抛错（保证测试不打真实网络）。 */
function fetchRouter(routes) {
  return async (url) => {
    for (const [needle, respond] of routes) {
      if (url.includes(needle)) return respond(url);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function rejectingFetch(message = 'network down') {
  return async () => {
    throw new Error(message);
  };
}

function makeGateway() {
  const handlers = new Map();
  return {
    handlers,
    register: (m, h) => handlers.set(m, h),
    dispatch: (m, p) => handlers.get(m)(p || {})
  };
}

function makeDeps(over = {}) {
  const broadcasts = [];
  const deps = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-host-dd-')),
    sleepImpl: async () => {},
    broadcastImpl: (payload) => broadcasts.push(payload),
    ...over
  };
  return { deps, broadcasts };
}

function moveDataDirUnderAnchor(deps) {
  // 让 <dataDir>/../package.json 锚点可用：mkdtemp 的父目录不可写包文件，
  // 改为 <fixture>/data 布局并把 package.json 放进 fixture 根
  const anchor = deps.dataDir;
  const data = path.join(anchor, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(anchor, 'package.json'), JSON.stringify({ version: '1.0.0-beta' }), 'utf8');
  deps.dataDir = data;
  return deps;
}

// ---------------------------------------------------------------------------
// plugin.listRemote：双源回退 / TTL 缓存 / stale 回退 / 全无
// ---------------------------------------------------------------------------

test('listRemote: 主源失败 → jsdelivr 镜像接管，写缓存且 stale:false', async () => {
  const { deps, broadcasts } = makeDeps();
  const registryJson = { updated: 'x', plugins: [{ id: 'alpha', version: '1.0.0' }] };
  const calls = [];
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    fetchImpl: fetchRouter([
      [REGISTRY_PRIMARY, async () => { calls.push('primary'); throw new Error('503'); }],
      [REGISTRY_MIRROR, async () => { calls.push('mirror'); return jsonResponse(registryJson); }]
    ])
  });

  const r = await gw.dispatch('plugin.listRemote');
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
  assert.equal(r.plugins[0].id, 'alpha');
  assert.deepEqual(calls, ['primary', 'mirror'], '先试主源再用镜像');
  assert.deepEqual(broadcasts, [], 'listRemote 不触发广播');

  // 缓存已落盘：<data>/cache/registry.json
  const cacheFile = path.join(deps.dataDir, 'cache', 'registry.json');
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cached.data.plugins[0].id, 'alpha');
  assert.ok(cached.fetchedAt > 0);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('listRemote: TTL 内命中缓存，不打网络', async () => {
  const { deps } = makeDeps();
  const cacheDir = path.join(deps.dataDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'registry.json'),
    JSON.stringify({ fetchedAt: Date.now(), data: { updated: 'x', plugins: [{ id: 'cached' }] } }),
    'utf8'
  );
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps, fetchImpl: rejectingFetch('should not be called') });

  const r = await gw.dispatch('plugin.listRemote');
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
  assert.equal(r.plugins[0].id, 'cached');
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('listRemote: 双源失败 → 回退 stale 缓存并标记 stale:true', async () => {
  const { deps } = makeDeps();
  const cacheDir = path.join(deps.dataDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'registry.json'),
    JSON.stringify({
      fetchedAt: Date.now() - 30 * 60 * 1000, // 超过 TTL
      data: { updated: 'x', plugins: [{ id: 'stale-entry' }] }
    }),
    'utf8'
  );
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps, fetchImpl: rejectingFetch() });

  const r = await gw.dispatch('plugin.listRemote');
  assert.equal(r.ok, true);
  assert.equal(r.stale, true, '回退缓存必须标记 stale');
  assert.equal(r.plugins[0].id, 'stale-entry');
  assert.ok(r.error, '携带失败原因');
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('listRemote: 双源失败且无缓存 → ok:false', async () => {
  const { deps } = makeDeps();
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps, fetchImpl: rejectingFetch() });

  const r = await gw.dispatch('plugin.listRemote');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('network down'));
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// plugin.install
// ---------------------------------------------------------------------------

test('install: registry 成功路径 —— 下载+tar 解压+sha 校验+落盘+记账+广播', async (t) => {
  const srcDir = path.join(root, 'fixture-src', 'ok-plugin');
  makeFixturePlugin(srcDir, { id: 'demo-plugin', version: '1.1.0' });
  const zipBuf = makeZip(srcDir);
  if (!zipBuf) return t.skip('系统 tar 无法创建 zip');
  const shasum = sha256(zipBuf);

  const registryJson = {
    updated: 'x',
    plugins: [
      { id: 'demo-plugin', version: '1.1.0', url: 'https://example.com/demo-1.1.0.zip', shasum }
    ]
  };
  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps); // zmodVersion 锚点 1.0.0-beta
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    fetchImpl: fetchRouter([
      ['example.com/demo-1.1.0.zip', () => binResponse(zipBuf)],
      [REGISTRY_PRIMARY, () => jsonResponse(registryJson)],
      [REGISTRY_MIRROR, () => jsonResponse(registryJson)]
    ])
  });

  const r = await gw.dispatch('plugin.install', { source: 'registry:demo-plugin' });
  assert.deepEqual({ ok: r.ok, id: r.id, version: r.version }, { ok: true, id: 'demo-plugin', version: '1.1.0' });

  // 落盘
  assert.equal(fs.readFileSync(path.join(deps.dataDir, 'plugins', 'demo-plugin', 'index.js'), 'utf8'), 'export default {};\n');
  // 记账
  const entry = getInstalledEntry(deps.dataDir, 'demo-plugin');
  assert.equal(entry.source, 'registry');
  assert.equal(entry.version, '1.1.0');
  assert.equal(entry.sourceRef, 'https://example.com/demo-1.1.0.zip');
  assert.equal(entry.shasum, shasum);
  // 广播：payload 形态 + entryUrl 带 ?v=<version>-<mtime>
  assert.equal(broadcasts.length, 1);
  const payload = broadcasts[0];
  assert.equal(payload.action, 'installed');
  assert.equal(payload.id, 'demo-plugin');
  assert.equal(payload.manifest.id, 'demo-plugin');
  assert.match(payload.entryUrl, /^zmod-local:\/\/plugins\/demo-plugin\/index\.js\?v=1\.1\.0-\d+(\.\d+)?$/);
  // tmp 已清理
  assert.deepEqual(fs.readdirSync(path.join(deps.dataDir, 'tmp')), []);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('install: sha256 不符拒装', async (t) => {
  const srcDir = path.join(root, 'fixture-src', 'sha-plugin');
  makeFixturePlugin(srcDir, { id: 'sha-plugin', version: '1.0.0' });
  const zipBuf = makeZip(srcDir);
  if (!zipBuf) return t.skip('系统 tar 无法创建 zip');

  const registryJson = {
    updated: 'x',
    plugins: [
      { id: 'sha-plugin', version: '1.0.0', url: 'https://example.com/sha.zip', shasum: 'f'.repeat(64) }
    ]
  };
  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    fetchImpl: fetchRouter([
      ['example.com/sha.zip', () => binResponse(zipBuf)],
      [REGISTRY_PRIMARY, () => jsonResponse(registryJson)]
    ])
  });

  const r = await gw.dispatch('plugin.install', { source: 'registry:sha-plugin' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('sha256'), `错误应说明 sha 校验: ${r.error}`);
  assert.ok(!fs.existsSync(path.join(deps.dataDir, 'plugins', 'sha-plugin')), '校验失败不落盘');
  assert.deepEqual(broadcasts, []);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('install: engine 不满足拒装（fail-closed）', async () => {
  const srcDir = path.join(root, 'fixture-src', 'engine-plugin');
  makeFixturePlugin(srcDir, { id: 'engine-plugin', version: '1.0.0', engine: { zmod: '>=9.9.9' } });
  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    resolveSource: async () => ({
      dir: srcDir,
      cleanup: () => {},
      source: 'zip',
      sourceRef: 'https://example.com/engine-plugin.zip',
      shasum: ''
    })
  });

  const r = await gw.dispatch('plugin.install', { source: 'zip:https://example.com/engine-plugin.zip' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('引擎'), `错误应说明引擎兼容性: ${r.error}`);
  assert.ok(!fs.existsSync(path.join(deps.dataDir, 'plugins', 'engine-plugin')));
  assert.deepEqual(broadcasts, []);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('install: manifest schema 校验拒装', async () => {
  const srcDir = path.join(root, 'fixture-src', 'bad-plugin');
  makeFixturePlugin(srcDir, { id: 'bad_plugin', version: 'not-semver' });
  const { deps } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    resolveSource: async () => ({ dir: srcDir, cleanup: () => {}, source: 'git', sourceRef: 'https://x/y.git', shasum: '' })
  });

  const r = await gw.dispatch('plugin.install', { source: 'git:https://x/y.git' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('manifest'), r.error);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('install: 已安装拒装', async () => {
  const srcDir = path.join(root, 'fixture-src', 'dup-plugin');
  makeFixturePlugin(srcDir, { id: 'dup-plugin', version: '1.0.0' });
  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    resolveSource: async () => ({ dir: srcDir, cleanup: () => {}, source: 'git', sourceRef: 'https://x/dup.git', shasum: '' })
  });

  const first = await gw.dispatch('plugin.install', { source: 'git:https://x/dup.git' });
  assert.equal(first.ok, true);
  const second = await gw.dispatch('plugin.install', { source: 'git:https://x/dup.git' });
  assert.equal(second.ok, false);
  assert.ok(second.error.includes('已安装'), second.error);
  assert.equal(broadcasts.length, 1, '第二次安装不广播');
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('install: 无效 source 形态报错', async () => {
  const { deps } = makeDeps();
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps });
  const missing = await gw.dispatch('plugin.install', {});
  assert.equal(missing.ok, false);
  const bad = await gw.dispatch('plugin.install', { source: 'npm:lodash' });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('不支持的安装来源'));
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// plugin.installUpload（设置页拖放安装管线）
// ---------------------------------------------------------------------------

test('installUpload: zip 成功 —— 默认 enabled=false + 记账 drop 来源 + 广播 installed + tmp 回收', async (t) => {
  const srcDir = path.join(root, 'fixture-src', 'drop-zip-plugin');
  makeFixturePlugin(srcDir, { id: 'drop-zip-plugin', version: '1.2.0' });
  const zipBuf = makeZip(srcDir);
  if (!zipBuf) return t.skip('系统 tar 无法创建 zip');

  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps });

  const r = await gw.dispatch('plugin.installUpload', {
    kind: 'zip',
    name: 'drop-zip-plugin.zip',
    zipBase64: zipBuf.toString('base64')
  });
  assert.deepEqual({ ok: r.ok, id: r.id, version: r.version }, { ok: true, id: 'drop-zip-plugin', version: '1.2.0' });
  assert.equal(
    fs.readFileSync(path.join(deps.dataDir, 'plugins', 'drop-zip-plugin', 'index.js'), 'utf8'),
    'export default {};\n'
  );
  const entry = getInstalledEntry(deps.dataDir, 'drop-zip-plugin');
  assert.equal(entry.source, 'zip');
  assert.equal(entry.sourceRef, 'drop:drop-zip-plugin.zip');
  assert.equal(entry.shasum, sha256(zipBuf));
  assert.equal(
    configManager.get().plugins['drop-zip-plugin']?.enabled,
    false,
    '拖放安装默认未启用，必须进未启用区等用户确认'
  );
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].action, 'installed');
  assert.equal(broadcasts[0].id, 'drop-zip-plugin');
  assert.deepEqual(fs.readdirSync(path.join(deps.dataDir, 'tmp')), [], '临时 holder 已回收');
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('installUpload: files 成功 —— 根级 manifest/index 落盘 + 记账 dir + 默认 enabled=false', async () => {
  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps });

  const manifest = {
    id: 'drop-files-plugin',
    name: 'Fixture drop-files-plugin',
    version: '0.3.0',
    description: 'fixture 插件',
    author: 'test'
  };
  const r = await gw.dispatch('plugin.installUpload', {
    kind: 'files',
    name: 'drop-files-plugin',
    files: [
      { path: 'manifest.json', b64: Buffer.from(JSON.stringify(manifest)).toString('base64') },
      { path: 'index.js', b64: Buffer.from('export default {};\n').toString('base64') },
      { path: 'lib/util.js', b64: Buffer.from('export const x = 1;\n').toString('base64') }
    ]
  });
  assert.deepEqual({ ok: r.ok, id: r.id, version: r.version }, { ok: true, id: 'drop-files-plugin', version: '0.3.0' });
  assert.equal(
    fs.readFileSync(path.join(deps.dataDir, 'plugins', 'drop-files-plugin', 'lib', 'util.js'), 'utf8'),
    'export const x = 1;\n',
    '子目录文件相对路径落盘'
  );
  const entry = getInstalledEntry(deps.dataDir, 'drop-files-plugin');
  assert.equal(entry.source, 'dir');
  assert.equal(entry.sourceRef, 'drop:drop-files-plugin');
  assert.equal(configManager.get().plugins['drop-files-plugin']?.enabled, false, '默认未启用');
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].action, 'installed');
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('installUpload: files 缺根级 manifest.json → 拒绝且不落盘', async () => {
  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps });

  const r = await gw.dispatch('plugin.installUpload', {
    kind: 'files',
    name: 'no-manifest',
    files: [{ path: 'index.js', b64: Buffer.from('export default {};\n').toString('base64') }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('manifest'), r.error);
  assert.equal(fs.existsSync(path.join(deps.dataDir, 'plugins', 'no-manifest')), false, '不落盘');
  assert.deepEqual(broadcasts, []);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('installUpload: files 路径穿越与绝对路径 → 拒绝', async () => {
  const { deps } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps });

  const manifest = {
    id: 'evil-plugin',
    name: 'evil',
    version: '1.0.0',
    description: 'x',
    author: 'test'
  };
  const mB64 = Buffer.from(JSON.stringify(manifest)).toString('base64');
  const iB64 = Buffer.from('export default {};\n').toString('base64');

  const trav = await gw.dispatch('plugin.installUpload', {
    kind: 'files',
    name: 'evil',
    files: [
      { path: 'manifest.json', b64: mB64 },
      { path: 'index.js', b64: iB64 },
      { path: '../evil.js', b64: iB64 }
    ]
  });
  assert.equal(trav.ok, false);
  assert.ok(trav.error.includes('..'), trav.error);

  const abs = await gw.dispatch('plugin.installUpload', {
    kind: 'files',
    name: 'evil',
    files: [
      { path: 'manifest.json', b64: mB64 },
      { path: 'index.js', b64: iB64 },
      { path: 'C:/Windows/evil.js', b64: iB64 }
    ]
  });
  assert.equal(abs.ok, false);
  assert.ok(abs.error.includes('绝对路径'), abs.error);
  assert.equal(fs.existsSync(path.join(deps.dataDir, 'plugins', 'evil-plugin')), false, '两种形态均不落盘');
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('installUpload: 解码后超 20MB → 拒绝', async () => {
  const { deps } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps });

  const big = Buffer.alloc(20 * 1024 * 1024 + 1);
  const r = await gw.dispatch('plugin.installUpload', {
    kind: 'zip',
    name: 'huge.zip',
    zipBase64: big.toString('base64')
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('过大'), r.error);
  const tmpDir = path.join(deps.dataDir, 'tmp');
  const tmpEmpty = !fs.existsSync(tmpDir) || fs.readdirSync(tmpDir).length === 0;
  assert.equal(tmpEmpty, true, '拒绝路径不产生临时目录残留');
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// plugin.remove
// ---------------------------------------------------------------------------

test('remove: 目录+账本双清, enabled 键删除(重装默认启用), settings 保留; 不存在的 id 报错', async () => {
  const { deps, broadcasts } = makeDeps();
  const pluginDir = path.join(deps.dataDir, 'plugins', 'gone-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default {};\n');
  recordInstalled(deps.dataDir, 'gone-plugin', { version: '0.2.0', source: 'registry' });

  // 用户先关掉插件并写过设置，再移除：enabled 键应被清掉，settings 保留
  configManager.setPluginEnabled('gone-plugin', false);
  configManager.setPluginSetting('gone-plugin', 'opacity', 0.7);

  const gw = makeGateway();
  registerPluginHost(gw, { ...deps });

  const missing = await gw.dispatch('plugin.remove', { id: 'never-there' });
  assert.equal(missing.ok, false);
  assert.deepEqual(broadcasts, [], 'remove 失败不广播');

  const r = await gw.dispatch('plugin.remove', { id: 'gone-plugin' });
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.existsSync(pluginDir), false, '插件目录已删');
  assert.equal(getInstalledEntry(deps.dataDir, 'gone-plugin'), null, '账本已移除');
  assert.equal(configManager.get().plugins['gone-plugin']?.enabled, undefined, 'enabled 键已删除（重装默认启用）');
  assert.equal(configManager.getPluginSetting('gone-plugin', 'opacity'), 0.7, 'settings 数据保留');
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].action, 'removed');
  assert.equal(broadcasts[0].id, 'gone-plugin');
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// plugin.update
// ---------------------------------------------------------------------------

/** 更新场景公共底座：本地装 v1.1.0（registry 来源），registry 数据可切换。 */
function setupUpdateFixture(deps, { localVersion = '1.1.0' } = {}) {
  const dest = path.join(deps.dataDir, 'plugins', 'demo-plugin');
  makeFixturePlugin(dest, { id: 'demo-plugin', version: localVersion });
  recordInstalled(deps.dataDir, 'demo-plugin', {
    version: localVersion,
    source: 'registry',
    sourceRef: 'https://example.com/demo.zip',
    shasum: ''
  });
  return dest;
}

test('update: registry 同版 → updated:false 不动盘', async () => {
  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  setupUpdateFixture(deps, { localVersion: '1.1.0' });
  const registryJson = {
    updated: 'x',
    plugins: [{ id: 'demo-plugin', version: '1.1.0', url: 'https://example.com/demo.zip', shasum: 'x' }]
  };
  let zipHit = 0;
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    fetchImpl: fetchRouter([
      ['example.com/demo.zip', () => { zipHit++; return binResponse(Buffer.alloc(1)); }],
      [REGISTRY_PRIMARY, () => jsonResponse(registryJson)],
      [REGISTRY_MIRROR, () => jsonResponse(registryJson)]
    ])
  });

  const r = await gw.dispatch('plugin.update', { id: 'demo-plugin' });
  assert.deepEqual(r, { ok: true, updated: false, version: '1.1.0' });
  assert.equal(zipHit, 0, '同版本不下载 zip');
  assert.deepEqual(broadcasts, [], '无更新不广播');
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('update: registry 新版 → 下载替换+记账+广播 updated', async (t) => {
  const srcDir = path.join(root, 'fixture-src', 'newver-plugin');
  makeFixturePlugin(srcDir, { id: 'demo-plugin', version: '1.2.0' });
  const zipBuf = makeZip(srcDir);
  if (!zipBuf) return t.skip('系统 tar 无法创建 zip');
  const shasum = sha256(zipBuf);

  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  setupUpdateFixture(deps, { localVersion: '1.1.0' });
  const registryJson = {
    updated: 'x',
    plugins: [{ id: 'demo-plugin', version: '1.2.0', url: 'https://example.com/demo-1.2.0.zip', shasum }]
  };
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    fetchImpl: fetchRouter([
      ['example.com/demo-1.2.0.zip', () => binResponse(zipBuf)],
      [REGISTRY_PRIMARY, () => jsonResponse(registryJson)]
    ])
  });

  const r = await gw.dispatch('plugin.update', { id: 'demo-plugin' });
  assert.deepEqual({ ok: r.ok, updated: r.updated, version: r.version }, { ok: true, updated: true, version: '1.2.0' });

  const manifest = JSON.parse(fs.readFileSync(path.join(deps.dataDir, 'plugins', 'demo-plugin', 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.2.0', '目录内容已替换');
  const entry = getInstalledEntry(deps.dataDir, 'demo-plugin');
  assert.equal(entry.version, '1.2.0');
  assert.equal(entry.source, 'registry');
  assert.equal(entry.shasum, shasum);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].action, 'updated');
  assert.match(broadcasts[0].entryUrl, /index\.js\?v=1\.2\.0-/);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('update: registry 版本更低 → 拒绝降级', async () => {
  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  setupUpdateFixture(deps, { localVersion: '1.1.0' });
  const registryJson = {
    updated: 'x',
    plugins: [{ id: 'demo-plugin', version: '0.9.0', url: 'https://example.com/old.zip', shasum: 'x' }]
  };
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    fetchImpl: fetchRouter([[REGISTRY_PRIMARY, () => jsonResponse(registryJson)]])
  });

  const r = await gw.dispatch('plugin.update', { id: 'demo-plugin' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('拒绝降级'), r.error);
  assert.deepEqual(broadcasts, []);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

test('update: zip/dir/builtin 来源 → 该来源不支持自动更新', async () => {
  for (const source of ['zip', 'dir', 'builtin']) {
    const { deps } = makeDeps();
    moveDataDirUnderAnchor(deps);
    setupUpdateFixture(deps);
    recordInstalled(deps.dataDir, 'demo-plugin', { version: '1.1.0', source });
    const gw = makeGateway();
    registerPluginHost(gw, { ...deps, fetchImpl: rejectingFetch('不应发起网络请求') });
    const r = await gw.dispatch('plugin.update', { id: 'demo-plugin' });
    assert.equal(r.ok, false, `source=${source}`);
    assert.ok(r.error.includes('该来源不支持自动更新'), `source=${source}: ${r.error}`);
    fs.rmSync(deps.dataDir, { recursive: true, force: true });
  }
});

test('update: git 来源 —— 新版克隆替换，同版 updated:false', async () => {
  // 新版
  const { deps, broadcasts } = makeDeps();
  moveDataDirUnderAnchor(deps);
  setupUpdateFixture(deps, { localVersion: '1.1.0' });
  recordInstalled(deps.dataDir, 'demo-plugin', { version: '1.1.0', source: 'git', sourceRef: 'https://github.com/x/demo.git' });

  const newerDir = path.join(root, 'fixture-src', 'git-newer');
  makeFixturePlugin(newerDir, { id: 'demo-plugin', version: '2.0.0' });
  const gw = makeGateway();
  registerPluginHost(gw, {
    ...deps,
    cloneImpl: async (url, destDir) => {
      assert.equal(url, 'https://github.com/x/demo.git');
      fs.cpSync(newerDir, destDir, { recursive: true });
    }
  });
  const r = await gw.dispatch('plugin.update', { id: 'demo-plugin' });
  assert.deepEqual({ ok: r.ok, updated: r.updated, version: r.version }, { ok: true, updated: true, version: '2.0.0' });
  const entry = getInstalledEntry(deps.dataDir, 'demo-plugin');
  assert.equal(entry.source, 'git');
  assert.equal(entry.version, '2.0.0');
  assert.equal(broadcasts[0].action, 'updated');

  // 同版
  const { deps: deps2, broadcasts: broadcasts2 } = makeDeps();
  moveDataDirUnderAnchor(deps2);
  setupUpdateFixture(deps2, { localVersion: '1.1.0' });
  recordInstalled(deps2.dataDir, 'demo-plugin', { version: '1.1.0', source: 'git', sourceRef: 'https://github.com/x/demo.git' });
  const sameDir = path.join(root, 'fixture-src', 'git-same');
  makeFixturePlugin(sameDir, { id: 'demo-plugin', version: '1.1.0' });
  const gw2 = makeGateway();
  registerPluginHost(gw2, {
    ...deps2,
    cloneImpl: async (_url, destDir) => fs.cpSync(sameDir, destDir, { recursive: true })
  });
  const r2 = await gw2.dispatch('plugin.update', { id: 'demo-plugin' });
  assert.deepEqual(r2, { ok: true, updated: false, version: '1.1.0' });
  assert.deepEqual(broadcasts2, []);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
  fs.rmSync(deps2.dataDir, { recursive: true, force: true });
});

test('update: 账本无记录 → 提示先重装记账', async () => {
  const { deps } = makeDeps();
  moveDataDirUnderAnchor(deps);
  const dest = path.join(deps.dataDir, 'plugins', 'orphan');
  makeFixturePlugin(dest, { id: 'orphan', version: '1.0.0' });
  const gw = makeGateway();
  registerPluginHost(gw, { ...deps, fetchImpl: rejectingFetch() });
  const r = await gw.dispatch('plugin.update', { id: 'orphan' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('账本'), r.error);
  fs.rmSync(deps.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeBuiltinRecords
// ---------------------------------------------------------------------------

test('广播通道名为 zmod:plugin-changed', () => {
  assert.equal(PLUGIN_CHANGED_CHANNEL, 'zmod:plugin-changed');
});


test('writeBuiltinRecords: 读 manifest 版本写入 builtin 记账', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-host-builtin-'));
  const p1 = path.join(dir, 'plugins', 'b-one');
  makeFixturePlugin(p1, { id: 'b-one', version: '0.5.0' });

  const recorded = writeBuiltinRecords(dir, ['b-one', 'b-missing']);
  assert.deepEqual(recorded, ['b-one'], '目录不存在的 id 跳过且不抛错');

  const ledger = readInstalled(dir);
  assert.equal(ledger.plugins['b-one'].source, 'builtin');
  assert.equal(ledger.plugins['b-one'].version, '0.5.0');
  assert.equal(ledger.plugins['b-missing'], undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
