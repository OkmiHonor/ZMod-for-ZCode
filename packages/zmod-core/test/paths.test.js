import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { getUserDataDir, getLegacyUserDataDir } = await import('../src/common/paths.js');

test('data dir follows the ZMod program dir (marker walk)', () => {
  // 本测试源码位于 <repo>/packages/zmod-core/src/common/paths.js，
  // 向上应命中含 packages/zmod-cli/bin/zmod.js 的仓库根 → <repo>/data
  const dir = getUserDataDir();
  assert.equal(path.basename(dir), 'data');
  const repoRoot = path.dirname(dir);
  assert.ok(fs.existsSync(path.join(repoRoot, 'packages', 'zmod-cli', 'bin', 'zmod.js')));
});

test('legacy fallback dir differs from the program-dir data dir', () => {
  assert.notEqual(path.resolve(getUserDataDir()), path.resolve(getLegacyUserDataDir()));
});

test('env override wins over everything', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-paths-'));
  process.env.ZMOD_USER_DATA_DIR = tmp;
  try {
    const { getUserDataDir: fresh } = await import('../src/common/paths.js');
    assert.equal(fresh(), path.resolve(tmp));
  } finally {
    delete process.env.ZMOD_USER_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
