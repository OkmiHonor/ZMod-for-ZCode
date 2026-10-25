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
const { getPluginDataDir } = await import('../src/common/paths.js');

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
