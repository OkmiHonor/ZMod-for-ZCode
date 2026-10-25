import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readInstalled,
  getInstalledEntry,
  recordInstalled,
  removeInstalled
} from '../src/common/installed.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-installed-test-'));
}

test('readInstalled: 文件缺失返回空账本', () => {
  const dir = makeTempDir();
  assert.deepEqual(readInstalled(dir), { plugins: {} });
});

test('record → read 回读，含缺省 installedAt 与原子落盘', () => {
  const dir = makeTempDir();
  const entry = recordInstalled(dir, 'acrylic-window', {
    version: '1.0.0-beta',
    source: 'builtin'
  });
  assert.equal(entry.source, 'builtin');
  assert.ok(!Number.isNaN(Date.parse(entry.installedAt)), 'installedAt 应为 ISO8601 时间');

  const ledger = readInstalled(dir);
  assert.equal(ledger.plugins['acrylic-window'].version, '1.0.0-beta');
  assert.equal(ledger.plugins['acrylic-window'].source, 'builtin');
  assert.equal(ledger.plugins['acrylic-window'].sourceRef, '');
  assert.equal(ledger.plugins['acrylic-window'].shasum, '');

  assert.deepEqual(getInstalledEntry(dir, 'acrylic-window'), ledger.plugins['acrylic-window']);
  assert.equal(getInstalledEntry(dir, 'nope'), null);

  // 落盘的是合法 JSON 且位于 <dataDir>/installed.json
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'));
  assert.equal(onDisk.plugins['acrylic-window'].version, '1.0.0-beta');
  // 无 tmp 残留
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.tmp.')),
    []
  );
});

test('record 覆盖旧条目，source 枚举校验', () => {
  const dir = makeTempDir();
  recordInstalled(dir, 'p1', { version: '1.0.0', source: 'zip', shasum: 'abc' });
  recordInstalled(dir, 'p1', { version: '2.0.0', source: 'git', sourceRef: 'https://github.com/x/y' });

  const e = getInstalledEntry(dir, 'p1');
  assert.equal(e.version, '2.0.0');
  assert.equal(e.source, 'git');
  assert.equal(e.shasum, ''); // record 是整体替换：新条目未提供 shasum 则为缺省值
  assert.equal(e.sourceRef, 'https://github.com/x/y');

  for (const bad of ['npm', '', undefined, 'Builtin']) {
    assert.throws(() => recordInstalled(dir, 'p2', { version: '1.0.0', source: bad }));
  }
  assert.throws(() => recordInstalled(dir, '', { version: '1.0.0', source: 'zip' }));
  assert.throws(() => recordInstalled(dir, 'p2', null));
});

test('remove 后查无，remove 不存在的 id 返回 false', () => {
  const dir = makeTempDir();
  recordInstalled(dir, 'p1', { version: '1.0.0', source: 'dir' });
  assert.equal(removeInstalled(dir, 'p1'), true);
  assert.equal(getInstalledEntry(dir, 'p1'), null);
  assert.deepEqual(readInstalled(dir), { plugins: {} });
  assert.equal(removeInstalled(dir, 'p1'), false);
  assert.equal(removeInstalled(dir, 'never-existed'), false);
});

test('损坏 JSON 容错：warn 并返回空账本，随后可正常写入', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'installed.json'), '{ not valid json !!', 'utf8');

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.deepEqual(readInstalled(dir), { plugins: {} });
    assert.equal(getInstalledEntry(dir, 'x'), null);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some((w) => w.includes('installed.json')), '应通过 console.warn 提示');

  // 容错后账本可自愈：record 直接重建合法文件
  recordInstalled(dir, 'p1', { version: '1.0.0', source: 'registry' });
  assert.equal(getInstalledEntry(dir, 'p1').source, 'registry');
});

test('结构异常（plugins 非对象）同样容错', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ plugins: [1, 2] }), 'utf8');
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.deepEqual(readInstalled(dir), { plugins: {} });
  } finally {
    console.warn = origWarn;
  }
});
