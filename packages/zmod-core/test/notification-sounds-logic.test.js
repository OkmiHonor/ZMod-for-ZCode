import test from 'node:test';
import assert from 'node:assert/strict';

const {
  defaultSoundMap,
  resolveSound,
  dedupeKey,
  shouldPlay,
  mergeLibrary,
  base64ToUint8Array
} = await import('../../../plugins/notification-sounds/lib.js');

test('resolveSound: override wins, fallback to default, missing default', () => {
  const m = { ...defaultSoundMap(), completed: 'user:fanfare.wav' };
  assert.equal(resolveSound(m, 'completed'), 'user:fanfare.wav');
  assert.equal(resolveSound(m, 'failed'), 'builtin:pop');
  assert.equal(resolveSound(m, 'unknown-status'), 'builtin:pop');
  // default 键为空/缺失时解析为空串（运行时据此跳过播放）
  assert.equal(resolveSound({ ...m, default: '' }, 'failed'), '');
  assert.equal(resolveSound({}, 'completed'), '');
  assert.equal(resolveSound(null, 'completed'), '');
});

test('dedupeKey: request events key on body, task events on task identity', () => {
  const perm = { status: 'permission_request', body: '允许写入文件?', taskId: 'T1', requestId: 'R1' };
  const elic = { status: 'elicitation_request', body: '计划确认', taskId: 'T2', requestId: 'R2' };
  const done = { status: 'completed', taskId: 'T1', requestId: 'R1', body: 'ignored' };
  const fail = { status: 'failed', taskId: 'T1', requestId: 'R1', body: 'also ignored' };

  assert.equal(dedupeKey(perm), 's:permission_request:允许写入文件?');
  assert.equal(dedupeKey(elic), 's:elicitation_request:计划确认');
  assert.equal(dedupeKey(done), 't:completed:T1|R1');
  assert.equal(dedupeKey(fail), 't:failed:T1|R1');
  // 同任务不同 requestId 是不同的通知
  assert.notEqual(dedupeKey(done), dedupeKey({ ...done, requestId: 'R9' }));
});

test('shouldPlay: first true, duplicate false, expiry true, stale prune', () => {
  const evt = { status: 'completed', taskId: 'T1', requestId: 'R1' };
  const seen = new Map();
  assert.equal(shouldPlay(evt, seen, 1000), true);
  assert.equal(seen.get(dedupeKey(evt)), 1000);
  assert.equal(shouldPlay(evt, seen, 2000), false, 'window 内重复 → false');
  assert.equal(shouldPlay(evt, seen, 1000 + 2999), false);
  assert.equal(shouldPlay(evt, seen, 1000 + 3000), true, '到期 → true');
  // 过期条目被剪枝：seen 里不再留旧 ts
  assert.equal(seen.get(dedupeKey(evt)), 1000 + 3000);
  const old = new Map([['t:completed:T0|R0', 0], ['t:completed:T1|R1', 5000]]);
  assert.equal(shouldPlay({ status: 'completed', taskId: 'T2', requestId: 'R2' }, old, 3100), true);
  assert.equal(old.has('t:completed:T0|R0'), false, '过期键被清除');
  assert.equal(old.get('t:completed:T1|R1'), 5000, '未过期键保留');
  // 自定义窗口
  const w = new Map();
  assert.equal(shouldPlay(evt, w, 0, 500), true);
  assert.equal(shouldPlay(evt, w, 400, 500), false);
  assert.equal(shouldPlay(evt, w, 600, 500), true);
});

test('mergeLibrary: builtin order first, user sorted by name, malformed dropped', () => {
  const builtin = [
    { id: 'builtin:pop', name: '弹跳 Pop', file: 'assets/pop.wav', durationMs: 140 },
    { id: 'builtin:ding', name: '清脆 Ding', file: 'assets/ding.wav' }
  ];
  const users = [
    { name: 'zeta.wav', size: 10, mtimeMs: 1 },
    { name: 'alpha.mp3', size: 20, mtimeMs: 2 },
    'not-an-object',
    null,
    { size: 30 }, // 缺 name → 丢弃
    { name: '' } // 空 name → 丢弃
  ];
  const merged = mergeLibrary(builtin, users);
  assert.deepEqual(
    merged,
    [
      { id: 'builtin:pop', name: '弹跳 Pop', file: 'assets/pop.wav', scope: 'plugin', durationMs: 140 },
      { id: 'builtin:ding', name: '清脆 Ding', file: 'assets/ding.wav', scope: 'plugin' },
      { id: 'user:alpha.mp3', name: 'alpha.mp3', file: 'alpha.mp3', scope: 'data' },
      { id: 'user:zeta.wav', name: 'zeta.wav', file: 'zeta.wav', scope: 'data' }
    ]
  );
  // builtin 内的畸形条目同样丢弃（缺 id / 缺 file / 非对象）
  const badBuiltin = [{ id: 'x', file: '' }, { id: '', file: 'a.wav' }, { file: 'a.wav' }, 42, null, builtin[0]];
  assert.deepEqual(mergeLibrary(badBuiltin, []), [
    { id: 'builtin:pop', name: '弹跳 Pop', file: 'assets/pop.wav', scope: 'plugin', durationMs: 140 }
  ]);
  // 非数组入参安全兜底
  assert.deepEqual(mergeLibrary(null, undefined), []);
});

test('base64ToUint8Array matches Buffer.from(b64, base64) roundtrip', () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const b64 = Buffer.from(bytes).toString('base64');
  const out = base64ToUint8Array(b64);
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, bytes.length);
  assert.deepEqual(Buffer.from(out).equals(Buffer.from(b64, 'base64')), true);
  // 空串与非 ASCII 字节
  assert.equal(base64ToUint8Array('').length, 0);
  const bin = new Uint8Array([0, 1, 0xfe, 0xff]);
  assert.deepEqual(
    Buffer.from(base64ToUint8Array(Buffer.from(bin).toString('base64'))),
    Buffer.from(bin)
  );
});
