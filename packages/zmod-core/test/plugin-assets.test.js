import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---- 隔离：plugin-data 目录跟随 ZMOD_USER_DATA_DIR ----
const tempDir = path.join(os.tmpdir(), `zmod-plugin-assets-test-${Date.now()}`);
process.env.ZMOD_USER_DATA_DIR = tempDir;

const { registerPluginAssetApi, MAX_FILE_BYTES, MAX_TOTAL_BYTES } = await import(
  '../src/main/plugin-assets.js'
);
const { getPluginDataDir, getPluginsDir } = await import('../src/common/paths.js');

const handlers = new Map();
registerPluginAssetApi({ register: (m, h) => handlers.set(m, h) });

const b64 = (n, fill = 0x61) => Buffer.alloc(n, fill).toString('base64');

test('plugin asset API suite', async (t) => {
  await t.test('write → list → delete roundtrip', async () => {
    const write = handlers.get('plugin.writeAsset');
    const list = handlers.get('plugin.listAssets');
    const del = handlers.get('plugin.deleteAsset');

    const w = await write({ pluginId: 'notify-sounds', name: 'ding.mp3', base64: b64(1000) });
    assert.deepEqual({ ok: w.ok, name: w.name, size: w.size }, { ok: true, name: 'ding.mp3', size: 1000 });

    const l = await list({ pluginId: 'notify-sounds' });
    assert.equal(l.ok, true);
    assert.equal(l.assets.length, 1);
    assert.equal(l.assets[0].name, 'ding.mp3');
    assert.equal(l.assets[0].size, 1000);
    assert.equal(typeof l.assets[0].mtimeMs, 'number');

    assert.deepEqual(await del({ pluginId: 'notify-sounds', name: 'ding.mp3' }), { ok: true });
    assert.deepEqual((await list({ pluginId: 'notify-sounds' })).assets, []);
  });

  await t.test('list of a missing dir is empty, invalid id rejected', async () => {
    const list = handlers.get('plugin.listAssets');
    assert.deepEqual(await list({ pluginId: 'ghost-plugin' }), { ok: true, assets: [] });
    assert.equal((await list({ pluginId: '../evil' })).ok, false);
    assert.equal((await list({})).ok, false);
  });

  await t.test('extension whitelist rejects .exe/.js/.mp3.exe', async () => {
    const write = handlers.get('plugin.writeAsset');
    for (const name of ['evil.exe', 'script.js', 'sound.mp3.exe', 'noext']) {
      const r = await write({ pluginId: 'notify-sounds', name, base64: b64(10) });
      assert.equal(r.ok, false, name);
      assert.equal(r.error, 'Invalid name');
    }
  });

  await t.test('path traversal and separators rejected', async () => {
    const write = handlers.get('plugin.writeAsset');
    const del = handlers.get('plugin.deleteAsset');
    for (const name of ['../x.mp3', 'a/b.mp3', '..\\x.mp3', 'a:b.mp3', 'q?.mp3']) {
      assert.equal((await write({ pluginId: 'notify-sounds', name, base64: b64(10) })).ok, false, name);
      assert.equal((await del({ pluginId: 'notify-sounds', name })).ok, false, name);
    }
    // 目录里不应有任何文件落盘
    const dir = getPluginDataDir('notify-sounds');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepEqual(names.filter((n) => !n.includes('.tmp.')), []);
  });

  await t.test('oversize single file rejected', async () => {
    const write = handlers.get('plugin.writeAsset');
    assert.equal(MAX_FILE_BYTES, 2 * 1024 * 1024);
    const r = await write({ pluginId: 'notify-sounds', name: 'big.mp3', base64: b64(MAX_FILE_BYTES + 1) });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'File too large');
  });

  await t.test('total quota enforced across multiple writes', async () => {
    const write = handlers.get('plugin.writeAsset');
    const dir = getPluginDataDir('quota-plugin');
    fs.mkdirSync(dir, { recursive: true });
    // 直接落盘填充到接近 20MB 上限，绕开巨型 base64 构造
    fs.writeFileSync(path.join(dir, 'filler.mp3'), Buffer.alloc(MAX_TOTAL_BYTES - 1024));
    const r1 = await write({ pluginId: 'quota-plugin', name: 'fits.mp3', base64: b64(512) });
    assert.equal(r1.ok, true);
    const r2 = await write({ pluginId: 'quota-plugin', name: 'over.mp3', base64: b64(2048) });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'quota');
    // 替换同名字件不计旧文件体积：fits.mp3 再写更大仍可成功
    const r3 = await write({ pluginId: 'quota-plugin', name: 'fits.mp3', base64: b64(1024) });
    assert.equal(r3.ok, true);
  });

  await t.test('slugify: spaces→"-", uppercase ext lowered, unicode kept', async () => {
    const write = handlers.get('plugin.writeAsset');
    const list = handlers.get('plugin.listAssets');

    const r1 = await write({ pluginId: 'slug-plugin', name: 'my cool sound.mp3', base64: b64(10) });
    assert.equal(r1.ok, true);
    assert.equal(r1.name, 'my-cool-sound.mp3');

    const r2 = await write({ pluginId: 'slug-plugin', name: 'Alert.WAV', base64: b64(10) });
    assert.equal(r2.ok, true);
    assert.equal(r2.name, 'Alert.wav'); // 仅扩展名降小写，basename 保留原大小写

    const r3 = await write({ pluginId: 'slug-plugin', name: '铃声 提示音.mp3', base64: b64(10) });
    assert.equal(r3.ok, true);
    assert.equal(r3.name, '铃声-提示音.mp3');

    const names = (await list({ pluginId: 'slug-plugin' })).assets.map((a) => a.name);
    assert.deepEqual(names, ['Alert.wav', 'my-cool-sound.mp3', '铃声-提示音.mp3']);
  });

  await t.test('write replaces same-name asset atomically (no tmp leftovers)', async () => {
    const write = handlers.get('plugin.writeAsset');
    const list = handlers.get('plugin.listAssets');
    const r1 = await write({ pluginId: 'replace-plugin', name: 'x.mp3', base64: b64(100) });
    const r2 = await write({ pluginId: 'replace-plugin', name: 'x.mp3', base64: b64(200) });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    const assets = (await list({ pluginId: 'replace-plugin' })).assets;
    assert.equal(assets.length, 1);
    assert.equal(assets[0].size, 200);
  });

  await t.test('delete missing asset errors', async () => {
    const del = handlers.get('plugin.deleteAsset');
    const r = await del({ pluginId: 'notify-sounds', name: 'ghost.mp3' });
    assert.deepEqual(r, { ok: false, error: 'Not found' });
  });

  await t.test('invalid base64 rejected', async () => {
    const write = handlers.get('plugin.writeAsset');
    for (const bad of ['not base64!!', 'aGVsbG8=xyz', '', 123, null]) {
      const r = await write({ pluginId: 'notify-sounds', name: 'b.mp3', base64: bad });
      assert.equal(r.ok, false, String(bad));
    }
  });
});

test('plugin.listDir suite', async (t) => {
  const listDir = handlers.get('plugin.listDir');

  // ---- fixture: <plugins>/dsh-compat/{manifest.json,index.js,dsh-plugins/...} ----
  const pluginDir = path.join(getPluginsDir(), 'dsh-compat');
  fs.mkdirSync(path.join(pluginDir, 'dsh-plugins', 'dsh-pet'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'dsh-plugins', 'dsh-empty'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), '{"id":"dsh-compat"}');
  fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default {};');
  fs.writeFileSync(path.join(pluginDir, 'dsh-plugins', 'dsh-pet', 'client.js'), '// client entry');
  fs.writeFileSync(path.join(pluginDir, 'dsh-plugins', 'package.json'), '{}');

  await t.test('lists plugin root sorted, with type/size/mtimeMs', async () => {
    const r = await listDir({ pluginId: 'dsh-compat' });
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.entries.map((e) => `${e.name}:${e.type}`),
      ['dsh-plugins:dir', 'index.js:file', 'manifest.json:file']
    );
    const manifest = r.entries.find((e) => e.name === 'manifest.json');
    assert.equal(manifest.size, '{"id":"dsh-compat"}'.length);
    assert.equal(typeof manifest.mtimeMs, 'number');
  });

  await t.test('relPath subdirectory listing, missing relPath default = root', async () => {
    const sub = await listDir({ pluginId: 'dsh-compat', relPath: 'dsh-plugins/dsh-pet' });
    assert.equal(sub.ok, true);
    assert.deepEqual(sub.entries.map((e) => `${e.name}:${e.type}`), ['client.js:file']);

    const mid = await listDir({ pluginId: 'dsh-compat', relPath: 'dsh-plugins' });
    assert.deepEqual(mid.entries.map((e) => `${e.name}:${e.type}`), ['dsh-empty:dir', 'dsh-pet:dir', 'package.json:file']);

    // 空字符串 relPath 等价于缺省：列插件根目录
    const root = await listDir({ pluginId: 'dsh-compat', relPath: '' });
    assert.equal(root.ok, true);
    assert.equal(root.entries.length, 3);
  });

  await t.test('path escapes and traversal rejected', async () => {
    for (const bad of ['../usage-stats', 'dsh-plugins/../../bubble-notifications', 'a/../../b', '..\\x', 'C:/Windows', '/etc']) {
      const r = await listDir({ pluginId: 'dsh-compat', relPath: bad });
      assert.equal(r.ok, false, bad);
      assert.equal(r.error, 'Invalid path', bad);
    }
    // 单独一层 '..' 也在段级检查里被拒
    const dotdot = await listDir({ pluginId: 'dsh-compat', relPath: '..' });
    assert.equal(dotdot.ok, false);
  });

  await t.test('invalid plugin id rejected', async () => {
    for (const id of ['../evil', '', 'a/b', undefined]) {
      const r = await listDir({ pluginId: id });
      assert.equal(r.ok, false, String(id));
      assert.equal(r.error, 'Invalid plugin id');
    }
  });

  await t.test('missing dir yields empty entries, not an error', async () => {
    assert.deepEqual(await listDir({ pluginId: 'dsh-compat', relPath: 'no-such-dir' }), {
      ok: true,
      entries: []
    });
    assert.deepEqual(await listDir({ pluginId: 'ghost-plugin' }), { ok: true, entries: [] });
  });
});

test('plugin.installArchive and plugin.removeDir suite', async (t) => {
  const installArchive = handlers.get('plugin.installArchive');
  const removeDir = handlers.get('plugin.removeDir');
  const { spawnSync } = await import('node:child_process');

  const pluginDir = path.join(getPluginsDir(), 'dsh-compat');
  fs.mkdirSync(pluginDir, { recursive: true });

  const tarBin =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';

  // 制作一个 mock tarball: package/{package.json,lib/client.js}
  const fixtureWork = path.join(tempDir, 'fixture-tarball-build');
  fs.mkdirSync(path.join(fixtureWork, 'package', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(fixtureWork, 'package', 'package.json'), JSON.stringify({ name: 'mock-dsh-pkg', version: '1.0.0' }));
  fs.writeFileSync(path.join(fixtureWork, 'package', 'lib', 'client.js'), '// mock client');
  const tgzFile = path.join(tempDir, 'mock-pkg.tgz');
  spawnSync(tarBin, ['-czf', tgzFile, '-C', fixtureWork, 'package']);
  const tgzBuf = fs.readFileSync(tgzFile);

  const mockFetch = async (url) => {
    if (url.includes('not-found')) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => tgzBuf.buffer.slice(tgzBuf.byteOffset, tgzBuf.byteOffset + tgzBuf.byteLength)
    };
  };

  await t.test('installArchive downloads, extracts, unwraps package/ and replaces dir', async () => {
    const res = await installArchive({
      pluginId: 'dsh-compat',
      relPath: 'dsh-plugins/mock-dsh-pkg',
      url: 'https://registry.npmmirror.com/mock-dsh-pkg/-/mock-dsh-pkg-1.0.0.tgz',
      fetchImpl: mockFetch
    });
    assert.equal(res.ok, true);
    assert.equal(res.name, 'mock-dsh-pkg');

    const dest = path.join(pluginDir, 'dsh-plugins', 'mock-dsh-pkg');
    assert.equal(fs.existsSync(dest), true);
    assert.equal(fs.existsSync(path.join(dest, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(dest, 'lib', 'client.js')), true);
    // 确认顶层 package/ 已剥离下钻
    assert.equal(fs.existsSync(path.join(dest, 'package')), false);
  });

  await t.test('installArchive security: path escape and root dir rejected', async () => {
    for (const bad of ['../escape', '..\\escape', '', '/', 'dsh-plugins/../../evil']) {
      const r = await installArchive({
        pluginId: 'dsh-compat',
        relPath: bad,
        url: 'https://registry.npmmirror.com/pkg.tgz',
        fetchImpl: mockFetch
      });
      assert.equal(r.ok, false, bad);
    }
  });

  await t.test('installArchive security: non-http(s) url rejected', async () => {
    const r = await installArchive({
      pluginId: 'dsh-compat',
      relPath: 'dsh-plugins/bad-url',
      url: 'file:///etc/passwd',
      fetchImpl: mockFetch
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Invalid archive URL (http/https only)');
  });

  await t.test('removeDir removes installed package subdirectory safely', async () => {
    const target = path.join(pluginDir, 'dsh-plugins', 'mock-dsh-pkg');
    assert.equal(fs.existsSync(target), true);

    const r = await removeDir({
      pluginId: 'dsh-compat',
      relPath: 'dsh-plugins/mock-dsh-pkg'
    });
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(target), false);
  });

  await t.test('removeDir security: root and traversal rejected', async () => {
    for (const bad of ['', '/', '../outside', 'dsh-plugins/../../other']) {
      const r = await removeDir({ pluginId: 'dsh-compat', relPath: bad });
      assert.equal(r.ok, false, bad);
    }
  });
});

