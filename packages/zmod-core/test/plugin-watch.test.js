import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// ---- 隔离：configManager 跟随 ZMOD_USER_DATA_DIR；watch 的 dataDir 由测试显式传入 ----
const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-watch-env-'));
process.env.ZMOD_USER_DATA_DIR = envRoot;

const {
  startPluginDirWatch,
  __pluginWatchTestHooks: hooks
} = await import('../src/main/plugin-host.js');
const { recordInstalled, getInstalledEntry } = await import('../src/common/installed.js');
const { configManager } = await import('../src/common/config.js');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeFixturePlugin(dir, { id = 'demo-plugin', version = '1.0.0', engine, withIndex = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (withIndex) fs.writeFileSync(path.join(dir, 'index.js'), 'export default {};\n');
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

/** 假 fs.watch 实例：记录 handler，测试用 handlers.get('change'|'error') 手动驱动。 */
function makeFakeWatcher() {
  const handlers = new Map();
  return {
    handlers,
    closed: false,
    on(ev, fn) {
      handlers.set(ev, fn);
      return this;
    },
    close() {
      this.closed = true;
    },
    unref() {}
  };
}

/**
 * 每例独立的 watch 环境：重置单例 → 临时 dataDir（可选先 seed）→ 注入假 watcher 启动。
 * nowImpl 可控（从 1_000_000 起步），用于测试 suppress 窗口的时间推进。
 */
function setupWatch({ seed } = {}) {
  hooks.resetForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-watch-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ version: '1.0.0-beta' }),
    'utf8'
  );
  if (seed) seed(dataDir);
  const watcher = makeFakeWatcher();
  const broadcasts = [];
  const now = { value: 1_000_000 };
  const started = startPluginDirWatch({
    dataDir,
    watchImpl: () => watcher,
    broadcastImpl: (p) => broadcasts.push(p),
    nowImpl: () => now.value
  });
  return {
    root,
    dataDir,
    pluginsDir: path.join(dataDir, 'plugins'),
    watcher,
    broadcasts,
    now,
    started
  };
}

function cleanup(env) {
  hooks.resetForTest();
  fs.rmSync(env.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

test('start: 目录不存在先建；单例防重入；error 后重置允许重建', () => {
  const env = setupWatch();
  assert.equal(env.started, true);
  assert.equal(fs.existsSync(env.pluginsDir), true, 'plugins 目录自动创建');

  // 单例：已 active 时再次启动返回 false
  assert.equal(startPluginDirWatch({ dataDir: env.dataDir, watchImpl: () => makeFakeWatcher() }), false);

  // error 事件 → 重置，允许重建
  env.watcher.handlers.get('error')(new Error('disk gone'));
  assert.equal(hooks.state.active, false);
  assert.equal(env.watcher.closed, true, '出错后关闭旧 watcher');
  const watcher2 = makeFakeWatcher();
  const started2 = startPluginDirWatch({ dataDir: env.dataDir, watchImpl: () => watcher2 });
  assert.equal(started2, true, '重置后可重建');
  cleanup(env);
});

// ---------------------------------------------------------------------------
// 防抖合并 + 自写忽略
// ---------------------------------------------------------------------------

test('防抖: 同目标多次事件合并为一次处理，异目标独立排队', async () => {
  const env = setupWatch({
    seed: (dd) => makeFixturePlugin(path.join(dd, 'plugins', 'alpha'), { id: 'alpha' })
  });

  hooks.onWatchEvent('change', 'alpha\\manifest.json');
  hooks.onWatchEvent('change', 'alpha\\index.js');
  hooks.onWatchEvent('change', 'alpha\\sub\\x.js');
  assert.equal(hooks.state.pending.size, 1, '同目标事件合并进同一个 pending');

  hooks.onWatchEvent('change', 'beta.zip');
  assert.equal(hooks.state.pending.size, 2, '异目标独立排队');

  await hooks.flushPending();
  assert.equal(hooks.state.pending.size, 0);
  assert.equal(env.broadcasts.length, 1, 'alpha 只处理一次（beta.zip 不存在且未知，不广播）');
  assert.equal(env.broadcasts[0].action, 'installed');
  assert.equal(env.broadcasts[0].id, 'alpha');
  cleanup(env);
});

test('suppress: 窗口内自写事件跳过（不广播不记账），窗口外照常处理', async () => {
  const env = setupWatch({
    seed: (dd) => makeFixturePlugin(path.join(dd, 'plugins', 'selfwrite'), { id: 'selfwrite' })
  });

  hooks.suppressInstallTarget('selfwrite');
  await hooks.processWatchTarget('selfwrite');
  assert.deepEqual(env.broadcasts, [], '窗口内跳过，不广播');
  assert.equal(getInstalledEntry(env.dataDir, 'selfwrite'), null, '窗口内不记账');

  env.now.value += 4000; // 越过 3000ms 抑制窗口
  await hooks.processWatchTarget('selfwrite');
  assert.equal(env.broadcasts.length, 1);
  assert.equal(env.broadcasts[0].action, 'installed');
  const entry = getInstalledEntry(env.dataDir, 'selfwrite');
  assert.equal(entry?.source, 'dir', '窗口外照常记账');
  assert.equal(hooks.state.suppress.has('selfwrite'), false, '过期抑制项已清理');
  cleanup(env);
});

// ---------------------------------------------------------------------------
// 目录投放
// ---------------------------------------------------------------------------

test('新目录: 合法 manifest → installed 广播 + 记账 dir + 默认启用 + 快照更新', async () => {
  const env = setupWatch();
  const dir = path.join(env.pluginsDir, 'drop-dir');
  makeFixturePlugin(dir, { id: 'drop-dir', version: '1.0.0' });

  await hooks.processWatchTarget('drop-dir');
  assert.equal(env.broadcasts.length, 1);
  const p = env.broadcasts[0];
  assert.equal(p.action, 'installed');
  assert.equal(p.id, 'drop-dir');
  assert.equal(p.manifest.id, 'drop-dir');
  assert.match(p.entryUrl, /^zmod-local:\/\/plugins\/drop-dir\/index\.js\?v=1\.0\.0-\d+(\.\d+)?$/);

  const entry = getInstalledEntry(env.dataDir, 'drop-dir');
  assert.equal(entry.source, 'dir');
  assert.equal(entry.sourceRef, 'watch:drop-dir');
  assert.equal(entry.version, '1.0.0');
  assert.equal(configManager.get().plugins['drop-dir']?.enabled, true, 'watch 安装默认启用');
  assert.equal(hooks.state.known.has('drop-dir'), true, '快照已收录');
  cleanup(env);
});

test('新目录: 账本已有该 id（非 dir 来源）→ 视为升级，广播 updated 且保留原 source', async () => {
  const env = setupWatch({
    seed: (dd) => {
      recordInstalled(dd, 'up-plugin', {
        version: '0.9.0',
        source: 'zip',
        sourceRef: 'https://example.com/up.zip',
        shasum: 'abc',
        installedAt: '2020-01-01T00:00:00.000Z'
      });
    }
  });
  const dir = path.join(env.pluginsDir, 'up-plugin');
  makeFixturePlugin(dir, { id: 'up-plugin', version: '1.1.0' });

  await hooks.processWatchTarget('up-plugin');
  assert.equal(env.broadcasts.length, 1);
  assert.equal(env.broadcasts[0].action, 'updated');
  assert.match(env.broadcasts[0].entryUrl, /index\.js\?v=1\.1\.0-/);

  const entry = getInstalledEntry(env.dataDir, 'up-plugin');
  assert.equal(entry.version, '1.1.0', '账本版本已刷新');
  assert.equal(entry.source, 'zip', '原 source 保留');
  assert.equal(entry.installedAt, '2020-01-01T00:00:00.000Z', '原 installedAt 保留');
  cleanup(env);
});

test('新目录: engine 不满足 → 忽略不广播不记账', async () => {
  const env = setupWatch();
  const dir = path.join(env.pluginsDir, 'engine-bad');
  makeFixturePlugin(dir, { id: 'engine-bad', version: '1.0.0', engine: { zmod: '>=9.9.9' } });

  await hooks.processWatchTarget('engine-bad');
  assert.deepEqual(env.broadcasts, []);
  assert.equal(getInstalledEntry(env.dataDir, 'engine-bad'), null);
  cleanup(env);
});

test('新目录: manifest schema 不合法 → 忽略', async () => {
  const env = setupWatch();
  const dir = path.join(env.pluginsDir, 'Bad_ID');
  makeFixturePlugin(dir, { id: 'Bad_ID', version: 'not-semver' });

  await hooks.processWatchTarget('Bad_ID');
  assert.deepEqual(env.broadcasts, []);
  assert.equal(getInstalledEntry(env.dataDir, 'Bad_ID'), null);
  cleanup(env);
});

test('新目录: 缺 index.js → 忽略（重试上限内放弃，不广播不记账）', async () => {
  const env = setupWatch();
  const dir = path.join(env.pluginsDir, 'no-entry');
  makeFixturePlugin(dir, { id: 'no-entry', withIndex: false });

  await hooks.processWatchTarget('no-entry'); // 未就绪 → 顺延重试
  assert.equal(hooks.state.pending.size, 1, '进入重试队列');
  await hooks.flushPending(); // 重试直到上限放弃
  assert.deepEqual(env.broadcasts, []);
  assert.equal(getInstalledEntry(env.dataDir, 'no-entry'), null);
  assert.equal(hooks.state.pending.size, 0, '重试链已收敛');
  cleanup(env);
});

test('新目录: 目录名与 manifest.id 不一致 → 忽略', async () => {
  const env = setupWatch();
  const dir = path.join(env.pluginsDir, 'mismatch');
  makeFixturePlugin(dir, { id: 'other-id', version: '1.0.0' });

  await hooks.processWatchTarget('mismatch');
  assert.deepEqual(env.broadcasts, []);
  assert.equal(getInstalledEntry(env.dataDir, 'other-id'), null);
  cleanup(env);
});

// ---------------------------------------------------------------------------
// zip 投放
// ---------------------------------------------------------------------------

test('zip: 成功链路 → 落盘 + zip 被删 + 记账 zip(含 sha256) + 广播 + tmp 回收', async (t) => {
  const srcDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-watch-zip-')), 'cooler');
  makeFixturePlugin(srcDir, { id: 'cooler', version: '2.0.0' });
  const zipBuf = makeZip(srcDir);
  if (!zipBuf) return t.skip('系统 tar 无法创建 zip');

  const env = setupWatch();
  const zipPath = path.join(env.pluginsDir, 'cooler.zip');
  fs.writeFileSync(zipPath, zipBuf);

  await hooks.processWatchTarget('cooler.zip');
  assert.equal(env.broadcasts.length, 1);
  const p = env.broadcasts[0];
  assert.equal(p.action, 'installed');
  assert.equal(p.id, 'cooler');
  assert.match(p.entryUrl, /^zmod-local:\/\/plugins\/cooler\/index\.js\?v=2\.0\.0-/);

  assert.equal(fs.existsSync(path.join(env.pluginsDir, 'cooler', 'index.js')), true, '插件已落盘');
  assert.equal(fs.existsSync(zipPath), false, '安装成功即收走投放的 zip');
  const entry = getInstalledEntry(env.dataDir, 'cooler');
  assert.equal(entry.source, 'zip');
  assert.equal(entry.sourceRef, 'watch:cooler.zip');
  assert.equal(entry.shasum, sha256(zipBuf));
  assert.equal(configManager.get().plugins.cooler?.enabled, true);
  assert.deepEqual(fs.readdirSync(path.join(env.dataDir, 'tmp')), [], 'holder 临时目录已回收');
  fs.rmSync(path.dirname(srcDir), { recursive: true, force: true });
  cleanup(env);
});

test('zip: 已装同 id → 视为无效投放，zip 保留且不覆盖', async (t) => {
  const srcDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-watch-zip-')), 'taken');
  makeFixturePlugin(srcDir, { id: 'taken', version: '3.0.0' });
  const zipBuf = makeZip(srcDir);
  if (!zipBuf) return t.skip('系统 tar 无法创建 zip');

  const env = setupWatch({
    seed: (dd) => {
      const dest = path.join(dd, 'plugins', 'taken');
      makeFixturePlugin(dest, { id: 'taken', version: '1.0.0' });
      recordInstalled(dd, 'taken', { version: '1.0.0', source: 'dir' });
    }
  });
  const zipPath = path.join(env.pluginsDir, 'taken.zip');
  fs.writeFileSync(zipPath, zipBuf);

  await hooks.processWatchTarget('taken.zip');
  assert.deepEqual(env.broadcasts, [], '已装 id 不广播');
  assert.equal(fs.existsSync(zipPath), true, 'zip 保留供用户自查');
  const entry = getInstalledEntry(env.dataDir, 'taken');
  assert.equal(entry.version, '1.0.0', '原安装未被覆盖');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(env.pluginsDir, 'taken', 'manifest.json'), 'utf8')).version,
    '1.0.0',
    '目录内容未被覆盖'
  );
  fs.rmSync(path.dirname(srcDir), { recursive: true, force: true });
  cleanup(env);
});

test('zip: manifest 无效 → 保留 zip 不落盘不广播', async (t) => {
  const srcDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-watch-zip-')), 'broken');
  makeFixturePlugin(srcDir, { id: 'Broken_Id', version: 'oops' });
  const zipBuf = makeZip(srcDir);
  if (!zipBuf) return t.skip('系统 tar 无法创建 zip');

  const env = setupWatch();
  const zipPath = path.join(env.pluginsDir, 'broken.zip');
  fs.writeFileSync(zipPath, zipBuf);

  await hooks.processWatchTarget('broken.zip');
  assert.deepEqual(env.broadcasts, []);
  assert.equal(fs.existsSync(zipPath), true, 'zip 保留');
  assert.equal(fs.existsSync(path.join(env.pluginsDir, 'Broken_Id')), false, '不落盘');
  fs.rmSync(path.dirname(srcDir), { recursive: true, force: true });
  cleanup(env);
});

// ---------------------------------------------------------------------------
// 目录消失
// ---------------------------------------------------------------------------

test('目录删除: 已知插件 → removed 广播 + 账本清 + 快照清 + enabled 键清', () => {
  const env = setupWatch({
    seed: (dd) => {
      const dir = path.join(dd, 'plugins', 'gone');
      makeFixturePlugin(dir, { id: 'gone', version: '1.0.0' });
      recordInstalled(dd, 'gone', { version: '1.0.0', source: 'dir' });
    }
  });
  assert.equal(hooks.state.known.has('gone'), true, '启动扫描收录快照');

  fs.rmSync(path.join(env.pluginsDir, 'gone'), { recursive: true, force: true });
  return hooks.processWatchTarget('gone').then(() => {
    assert.equal(env.broadcasts.length, 1);
    assert.deepEqual(env.broadcasts[0], { action: 'removed', id: 'gone', entryUrl: null, manifest: null });
    assert.equal(getInstalledEntry(env.dataDir, 'gone'), null, '账本已清');
    assert.equal(hooks.state.known.has('gone'), false, '快照已清');
    assert.equal(configManager.get().plugins.gone?.enabled, undefined, 'enabled 键已清');
  });
});

test('目录删除: 未知目标（临时文件等）→ 忽略不广播', async () => {
  const env = setupWatch();
  await hooks.processWatchTarget('scratch.tmp');
  assert.deepEqual(env.broadcasts, []);
  cleanup(env);
});
