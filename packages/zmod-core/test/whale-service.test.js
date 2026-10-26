import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSkinsDir, loadWhaleSkins, getWhaleModel } from '../src/main/whale-service.js';

test('scanSkinsDir: extracts skin images and meta.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-skins-test-'));
  try {
    const skinA = path.join(tmp, 'skin-a');
    fs.mkdirSync(skinA);
    fs.writeFileSync(path.join(skinA, 'image.png'), Buffer.from('fake-png-data'));
    fs.writeFileSync(path.join(skinA, 'meta.json'), JSON.stringify({ name: 'Alpha', pinned: true }));

    const skinB = path.join(tmp, 'skin-b');
    fs.mkdirSync(skinB);
    fs.writeFileSync(path.join(skinB, 'image.gif'), Buffer.from('fake-gif-data'));

    const list = scanSkinsDir(tmp, 'user');
    assert.equal(list.length, 2);

    const a = list.find((s) => s.id === 'skin-a');
    assert.ok(a);
    assert.equal(a.name, 'Alpha');
    assert.equal(a.pinned, true);
    assert.equal(a.format, 'png');
    assert.ok(a.data.startsWith('data:image/png;base64,'));

    const b = list.find((s) => s.id === 'skin-b');
    assert.ok(b);
    assert.equal(b.name, 'skin-b');
    assert.equal(b.pinned, false);
    assert.equal(b.format, 'gif');
    assert.ok(b.data.startsWith('data:image/gif;base64,'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadWhaleSkins: merges builtin and user skins with user overriding', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-whale-merge-'));
  try {
    const dataDir = path.join(tmp, 'data');
    const pluginsDir = path.join(tmp, 'plugins');
    const userSkinsDir = path.join(dataDir, 'whale-skins');
    const builtinSkinsDir = path.join(pluginsDir, 'whale-widget', 'skins');

    fs.mkdirSync(path.join(builtinSkinsDir, 'common-skin'), { recursive: true });
    fs.writeFileSync(path.join(builtinSkinsDir, 'common-skin', 'image.png'), Buffer.from('builtin-common'));
    fs.writeFileSync(
      path.join(builtinSkinsDir, 'common-skin', 'meta.json'),
      JSON.stringify({ name: 'Builtin Version' })
    );

    fs.mkdirSync(path.join(builtinSkinsDir, 'only-builtin'), { recursive: true });
    fs.writeFileSync(path.join(builtinSkinsDir, 'only-builtin', 'image.png'), Buffer.from('only-builtin'));

    fs.mkdirSync(path.join(userSkinsDir, 'common-skin'), { recursive: true });
    fs.writeFileSync(path.join(userSkinsDir, 'common-skin', 'image.png'), Buffer.from('user-override'));
    fs.writeFileSync(
      path.join(userSkinsDir, 'common-skin', 'meta.json'),
      JSON.stringify({ name: 'User Version' })
    );

    fs.mkdirSync(path.join(userSkinsDir, 'custom-hero'), { recursive: true });
    fs.writeFileSync(path.join(userSkinsDir, 'custom-hero', 'image.png'), Buffer.from('custom-hero'));

    const res = await loadWhaleSkins({ dataDir, pluginsDir });
    assert.equal(res.ok, true);
    assert.equal(res.skins.length, 3);

    const common = res.skins.find((s) => s.id === 'common-skin');
    assert.equal(common.name, 'User Version'); // Overridden by user
    assert.equal(common.source, 'user');

    const hero = res.skins.find((s) => s.id === 'custom-hero');
    assert.ok(hero);
    assert.equal(hero.source, 'user');

    const b = res.skins.find((s) => s.id === 'only-builtin');
    assert.ok(b);
    assert.equal(b.source, 'builtin');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getWhaleModel: validates taskId and queries sqlite', async () => {
  // 1. Invalid taskId
  const bad = await getWhaleModel({ taskId: 'invalid space id!' });
  assert.equal(bad.ok, false);

  // 2. Real tasks-index.sqlite (if present on user machine)
  const defaultDb = path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
  if (fs.existsSync(defaultDb)) {
    const res = await getWhaleModel({ taskId: 'session_3d1d6817fc2a9ff194ace8a1abbb58c6' });
    assert.equal(res.ok, true);
    assert.ok(typeof res.model === 'string');
    assert.ok(typeof res.provider === 'string');
  }
});
