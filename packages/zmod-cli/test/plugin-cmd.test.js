import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// 隔离数据目录：paths.js / installed.js / config.js 全部跟随该环境变量
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-cmd-'));
process.env.ZMOD_USER_DATA_DIR = dataRoot;

const {
  planUpdates,
  filterSearch,
  removeDirWithRetry,
  pluginCommand,
  buildScaffold,
  isRunningInsideDevRepo,
  resolvePluginSource,
  downloadZipWithFallback
} = await import('../src/commands/plugin.js');
const { readInstalled, getInstalledEntry } = await import('../../zmod-core/src/common/installed.js');
const { configManager } = await import('../../zmod-core/src/common/config.js');
const { validateManifestSchema, checkEngine } = await import('../../zmod-sdk/src/manifest.js');
const { createRequire } = await import('node:module');
const { version: CLI_VERSION } = createRequire(import.meta.url)('../package.json');

const registryJson = {
  updated: '2026-10-25T00:00:00.000Z',
  plugins: [
    {
      id: 'alpha',
      version: '1.0.0',
      url: 'https://example.com/plugins/alpha-1.0.0.zip',
      shasum: 'a'.repeat(64),
      manifest: { id: 'alpha', name: 'Alpha 插件', version: '1.0.0', description: 'alpha 描述', author: 't' }
    },
    {
      id: 'beta',
      version: '2.0.0',
      url: 'https://example.com/plugins/beta-2.0.0.zip',
      shasum: 'b'.repeat(64),
      manifest: { id: 'beta', name: 'Beta', version: '2.0.0', description: '含唯一关键词量子稳定', author: 't' }
    }
  ]
};

test('planUpdates: registry 同版→无动作, 新版→更新, git/zip 来源→跳过', () => {
  const local = [
    { id: 'alpha', source: 'registry', version: '1.0.0' },
    { id: 'beta', source: 'registry', version: '1.0.0' },
    { id: 'gamma', source: 'git', version: '0.1.0' },
    { id: 'delta', source: 'zip', version: '0.1.0' }
  ];
  const byId = Object.fromEntries(planUpdates(local, registryJson).map((d) => [d.id, d]));

  assert.equal(byId.alpha.action, 'latest', 'registry 同版本 → 无动作');
  assert.equal(byId.beta.action, 'update', 'registry 新版本 → 更新');
  assert.equal(byId.beta.targetVersion, '2.0.0');
  assert.equal(byId.beta.entry.url, registryJson.plugins[1].url, 'update 决策携带 registry 条目');
  assert.equal(byId.gamma.action, 'skip', 'git 来源不参与 registry 对比');
  assert.equal(byId.delta.action, 'skip', 'zip 来源跳过');
  assert.ok(byId.delta.reason.includes('不支持自动更新'));
});

test('planUpdates: registry 缺失→missing, 本地较新→不降级, 本地版本缺失→按可更新处理', () => {
  const [missing] = planUpdates([{ id: 'nope', source: 'registry', version: '1.0.0' }], registryJson);
  assert.equal(missing.action, 'missing');

  const [newerLocal] = planUpdates([{ id: 'alpha', source: 'registry', version: '9.9.9' }], registryJson);
  assert.equal(newerLocal.action, 'skip', '本地比 registry 新 → 跳过以免降级');

  const [unknownLocal] = planUpdates([{ id: 'alpha', source: 'registry', version: '' }], registryJson);
  assert.equal(unknownLocal.action, 'update', '本地版本缺失无法对比 → 按可更新处理');
});

test('filterSearch: 无关键词返回全部, 匹配 id/名称/描述, 大小写不敏感', () => {
  assert.deepEqual(filterSearch(registryJson).map((p) => p.id), ['alpha', 'beta']);
  assert.deepEqual(filterSearch(registryJson, 'ALPHA').map((p) => p.id), ['alpha'], '命中 id');
  assert.deepEqual(filterSearch(registryJson, '插件').map((p) => p.id), ['alpha'], '命中 name');
  assert.deepEqual(filterSearch(registryJson, '量子').map((p) => p.id), ['beta'], '命中 description');
  assert.deepEqual(filterSearch(registryJson, 'no-such-keyword-xyz'), []);
});

test('removeDirWithRetry: 两轮循环内删除非空目录成功, 已不存在也返回 true', async () => {
  const target = path.join(dataRoot, 'retry-target');
  fs.mkdirSync(path.join(target, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(target, 'nested', 'f.txt'), 'x');

  assert.equal(await removeDirWithRetry(target, { delayMs: 1 }), true);
  assert.equal(fs.existsSync(target), false, '目录已被删除');
  assert.equal(await removeDirWithRetry(target, { delayMs: 1 }), true, '目标已不存在视为成功');
});

test('install 记账到 installed.json 并铺设插件目录', async () => {
  const srcDir = path.join(dataRoot, 'fixture-src', 'demo-plugin');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), 'export default {};\n');
  fs.writeFileSync(
    path.join(srcDir, 'manifest.json'),
    JSON.stringify({ id: 'demo-plugin', name: 'Demo', version: '0.1.0', description: 'demo fixture', author: 'test' })
  );

  await pluginCommand('install', srcDir);

  const ledger = readInstalled(dataRoot);
  const entry = ledger.plugins['demo-plugin'];
  assert.ok(entry, 'installed.json 中出现 demo-plugin 条目');
  assert.equal(entry.source, 'dir');
  assert.equal(entry.version, '0.1.0');
  assert.equal(entry.sourceRef, path.resolve(srcDir));
  assert.equal(entry.shasum, '', '目录来源无 shasum');
  assert.ok(entry.installedAt, '记录安装时间');

  assert.ok(fs.existsSync(path.join(dataRoot, 'plugins', 'demo-plugin', 'index.js')), '插件目录已铺设');
});

test('install 校验: 非法 manifest 拒装, 已装提示 remove/update', async () => {
  // 拦截 process.exit：转为可断言的异常，同时让 install 的 finally 清理照常执行
  const origExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`__exit_${code}`);
  };
  try {
    const badDir = path.join(dataRoot, 'fixture-src', 'bad-plugin');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'index.js'), 'export default {};\n');
    fs.writeFileSync(
      path.join(badDir, 'manifest.json'),
      JSON.stringify({ id: 'bad_plugin', name: '', version: 'not-semver', description: 'x', author: 't' })
    );

    await assert.rejects(() => pluginCommand('install', badDir), /__exit_1/);
    assert.equal(exitCode, 1, 'manifest 校验失败以退出码 1 终止');
    assert.ok(!fs.existsSync(path.join(dataRoot, 'plugins', 'bad_plugin')), '校验失败的插件不落盘');

    // 同 id 重复安装：报"已安装"退出，账本仍只有一条
    exitCode = null;
    const srcDir = path.join(dataRoot, 'fixture-src', 'demo-plugin');
    await assert.rejects(() => pluginCommand('install', srcDir), /__exit_1/);
    const ledger = readInstalled(dataRoot);
    assert.equal(Object.keys(ledger.plugins).filter((k) => k === 'demo-plugin').length, 1);
  } finally {
    process.exit = origExit;
  }
});

test('isRunningInsideDevRepo: 数据目录位于 git 检出内 → true, 无 .git → false, 与 cwd 无关', () => {
  const makeFixture = (name, withGit) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zmod-devrepo-${name}-`));
    const dataDir = path.join(repoRoot, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    if (withGit) fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    return { repoRoot, dataDir };
  };
  const withGit = makeFixture('git', true);
  const withoutGit = makeFixture('plain', false);
  const prevData = process.env.ZMOD_USER_DATA_DIR;
  const prevCwd = process.cwd();
  try {
    // cwd 指向与仓库无关的目录：判定只看数据目录祖先链
    process.chdir(os.tmpdir());
    process.env.ZMOD_USER_DATA_DIR = withGit.dataDir;
    assert.equal(isRunningInsideDevRepo(), true, '祖先链存在 .git → dev 模式');

    process.env.ZMOD_USER_DATA_DIR = withoutGit.dataDir;
    assert.equal(isRunningInsideDevRepo(), false, '无 .git（部署安装布局）→ 非 dev 模式');
  } finally {
    process.env.ZMOD_USER_DATA_DIR = prevData;
    process.chdir(prevCwd);
    fs.rmSync(withGit.repoRoot, { recursive: true, force: true });
    fs.rmSync(withoutGit.repoRoot, { recursive: true, force: true });
  }
});

test('remove: 目录+账本清理, enabled 键删除(重装默认启用), settings 保留', async () => {
  const srcDir = path.join(dataRoot, 'fixture-src', 'rem-plugin');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), 'export default {};\n');
  fs.writeFileSync(
    path.join(srcDir, 'manifest.json'),
    JSON.stringify({ id: 'rem-plugin', name: 'Rem', version: '0.3.0', description: 'remove fixture', author: 't' })
  );
  await pluginCommand('install', srcDir);

  // 用户先关掉并写过设置，再移除：enabled 键应被清掉，settings 保留
  configManager.setPluginEnabled('rem-plugin', false);
  configManager.setPluginSetting('rem-plugin', 'opacity', 0.7);
  await pluginCommand('remove', 'rem-plugin');

  assert.equal(configManager.get().plugins['rem-plugin']?.enabled, undefined, 'enabled 键已被删除');
  assert.equal(configManager.isPluginEnabled('rem-plugin'), true, '重装默认启用');
  assert.equal(configManager.getPluginSetting('rem-plugin', 'opacity'), 0.7, 'settings 数据保留');
  assert.ok(!fs.existsSync(path.join(dataRoot, 'plugins', 'rem-plugin')), '插件目录已删');
  assert.equal(getInstalledEntry(dataRoot, 'rem-plugin'), null, '账本已移除');
});

test('buildScaffold: manifest 过 v2 校验且 engine 对当前 CLI 版本兼容', () => {
  const files = buildScaffold('my-scaffold');
  assert.deepEqual(
    Object.keys(files).sort(),
    ['README.md', 'index.js', 'manifest.json', 'test/my-scaffold.test.js'],
    '脚手架固定四件套'
  );

  const manifest = JSON.parse(files['manifest.json']);
  const schema = validateManifestSchema(manifest);
  assert.deepEqual(
    { ok: schema.ok, errors: schema.errors, warnings: schema.warnings },
    { ok: true, errors: [], warnings: [] },
    '脚手架 manifest 应零错误零警告'
  );
  assert.equal(checkEngine(manifest, { zmodVersion: CLI_VERSION }).ok, true, 'engine 下限对当前 CLI 兼容');
  assert.equal(manifest.engine.zmod, `>=${CLI_VERSION}`, 'engine 下限 = 当前 CLI 版本');

  // index.js 的 definePlugin 字面量与 manifest 一致（与 manifest-consistency 同思路）
  const slice = files['index.js'].slice(files['index.js'].indexOf('definePlugin('));
  assert.equal(slice.match(/\bid\s*:\s*'([^']+)'/)?.[1], manifest.id);
  assert.equal(slice.match(/\bversion\s*:\s*'([^']+)'/)?.[1], manifest.version);
});

test('plugin init: 生成脚手架目录, 重复目录/非法 id 拒绝', async () => {
  const initRoot = path.join(dataRoot, 'scaffold');
  await pluginCommand('init', 'demo-hello', ['--dir', initRoot]);

  const pluginDir = path.join(initRoot, 'demo-hello');
  for (const rel of ['manifest.json', 'index.js', 'README.md', 'test/demo-hello.test.js']) {
    assert.ok(fs.existsSync(path.join(pluginDir, rel)), `生成 ${rel}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'demo-hello');
  assert.equal(manifest.version, '0.1.0');

  // 目录已存在 → 退出码 1
  const origExit = process.exit;
  process.exit = (code) => {
    throw new Error(`__exit_${code}`);
  };
  try {
    await assert.rejects(() => pluginCommand('init', 'demo-hello', ['--dir', initRoot]), /__exit_1/);
    await assert.rejects(() => pluginCommand('init', 'Bad_Id', ['--dir', initRoot]), /__exit_1/, '非 kebab id 拒绝');
  } finally {
    process.exit = origExit;
  }
});

test('downloadZipWithFallback & resolvePluginSource: 支持裸 plugin-id / registry:<id> / 远端 .zip URL 及镜像回退', async (t) => {
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const pkgSrc = path.join(dataRoot, 'fixture-src', 'remote-pkg');
  fs.mkdirSync(pkgSrc, { recursive: true });
  fs.writeFileSync(path.join(pkgSrc, 'index.js'), 'export default {};\n');
  fs.writeFileSync(
    path.join(pkgSrc, 'manifest.json'),
    JSON.stringify({ id: 'remote-pkg', name: 'Remote', version: '1.0.0', description: 'r', author: 't' })
  );
  const zipFile = `${pkgSrc}.zip`;
  try {
    execFileSync(tarBin, ['-a', '-cf', zipFile, '-C', path.dirname(pkgSrc), path.basename(pkgSrc)]);
  } catch {
    return t.skip('系统 tar 无法创建 zip');
  }
  const zipBuf = fs.readFileSync(zipFile);
  const shasum = createHash('sha256').update(zipBuf).digest('hex');
  const ghUrl = 'https://github.com/OkmiHonor/ZMod-for-ZCode/releases/download/v1.0.0/remote-pkg-1.0.0.zip';

  // 1. downloadZipWithFallback: 第一候选 sha256 错误，第二候选成功
  const destZip = path.join(dataRoot, 'dl-test.zip');
  let calls = 0;
  const dlRes = await downloadZipWithFallback(ghUrl, destZip, shasum, {
    customMirror: '',
    fetchImpl: async (url) => {
      calls++;
      if (calls === 1) return new Response(Buffer.from('bad-html'), { status: 200 });
      return new Response(zipBuf, { status: 200, headers: { 'x-used': url } });
    }
  });
  assert.equal(dlRes.ok, true);
  assert.equal(dlRes.shasum, shasum);
  assert.ok(dlRes.usedUrl.startsWith('https://gh-proxy.com/'));

  // 2. resolvePluginSource: 裸 <id> 走 registry 解析并解压
  const fakeReg = {
    updated: '2026-10-26T00:00:00Z',
    plugins: [{ id: 'remote-pkg', version: '1.0.0', url: ghUrl, shasum }]
  };
  const resolved = await resolvePluginSource('remote-pkg', {
    fetchRegistry: async () => fakeReg,
    customMirror: '',
    fetchImpl: async () => new Response(zipBuf, { status: 200 })
  });
  try {
    assert.equal(resolved.source, 'registry');
    assert.equal(resolved.sourceRef, ghUrl);
    assert.equal(resolved.shasum, shasum);
    assert.ok(fs.existsSync(path.join(resolved.dir, 'manifest.json')));
  } finally {
    resolved.cleanup();
  }

  // 3. resolvePluginSource: 远端 .zip URL
  const resolvedZipUrl = await resolvePluginSource(ghUrl, {
    customMirror: '',
    fetchImpl: async () => new Response(zipBuf, { status: 200 })
  });
  try {
    assert.equal(resolvedZipUrl.source, 'zip');
    assert.equal(resolvedZipUrl.sourceRef, ghUrl);
    assert.equal(resolvedZipUrl.shasum, shasum);
    assert.ok(fs.existsSync(path.join(resolvedZipUrl.dir, 'index.js')));
  } finally {
    resolvedZipUrl.cleanup();
  }
});
