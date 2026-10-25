import test from 'node:test';
import assert from 'node:assert/strict';

const { STATUS_KIND, STATUS_SWITCH, dedupeKey, shouldDedupePass, shouldShow, defaultCopy, showParams } =
  await import('../../../plugins/bubble-notifications/lib.js');

const baseSnap = () => ({
  enabled: true,
  onCompleted: true,
  onFailed: true,
  onWaiting: true,
  duration: 5000,
  focusShow: false
});

test('STATUS_KIND: four statuses map onto bubble kinds', () => {
  assert.equal(STATUS_KIND.completed, 'success');
  assert.equal(STATUS_KIND.failed, 'error');
  assert.equal(STATUS_KIND.permission_request, 'waiting');
  assert.equal(STATUS_KIND.elicitation_request, 'waiting');
});

test('dedupeKey: request events key on body, task events on task identity', () => {
  const perm = { status: 'permission_request', body: '允许写入文件?', taskId: 'T1', requestId: 'R1' };
  const done = { status: 'completed', taskId: 'T1', requestId: 'R1', body: 'ignored' };

  assert.equal(dedupeKey(perm), 'req:允许写入文件?');
  assert.equal(dedupeKey({ ...perm, status: 'elicitation_request' }), 'req:允许写入文件?');
  assert.equal(dedupeKey(done), 'task:T1|R1');
});

test('shouldDedupePass: 3s window, per-key independence, map pruning', () => {
  const seen = new Map();
  const evt = { status: 'completed', taskId: 'T1', requestId: 'R1' };

  assert.equal(shouldDedupePass(evt, seen, 1000), true);
  assert.equal(shouldDedupePass(evt, seen, 3500), false, 'same key inside 3s is dropped');
  assert.equal(shouldDedupePass(evt, seen, 4100), true, 'window elapsed → key passes again');
  assert.equal(seen.size, 1, 'expired sighting is pruned');

  const other = { status: 'completed', taskId: 'T2', requestId: 'R2' };
  assert.equal(shouldDedupePass(other, seen, 4200), true, 'different task identity is independent');
});

test('shouldShow: master switch, focus gate, per-status gate', () => {
  const evt = { status: 'completed', taskId: 'T1', requestId: 'R1' };

  assert.equal(shouldShow(evt, { ...baseSnap(), enabled: false }, new Map(), 1), false);

  const focused = { ...evt, anyFocused: true };
  assert.equal(shouldShow(focused, baseSnap(), new Map(), 1), false);
  assert.equal(shouldShow(focused, { ...baseSnap(), focusShow: true }, new Map(), 1), true);

  assert.equal(shouldShow(evt, { ...baseSnap(), onCompleted: false }, new Map(), 1), false);
  assert.equal(
    shouldShow({ status: 'failed', taskId: 'T1', requestId: 'R1' }, { ...baseSnap(), onFailed: false }, new Map(), 1),
    false
  );
  const wait = { status: 'permission_request', body: '确认?' };
  assert.equal(shouldShow(wait, { ...baseSnap(), onWaiting: false }, new Map(), 1), false);
  assert.equal(
    shouldShow({ status: 'elicitation_request', body: 'x' }, { ...baseSnap(), onWaiting: false }, new Map(), 1),
    false
  );

  assert.equal(shouldShow({ status: 'mystery', taskId: 'T9' }, baseSnap(), new Map(), 1), false, 'unknown status dropped');
  assert.equal(shouldShow(null, baseSnap(), new Map(), 1), false);
});

test('defaultCopy: explicit title wins, fallback per status, body passes through', () => {
  assert.deepEqual(defaultCopy({ status: 'completed', title: '构建完成', body: '耗时 3 分钟' }), {
    title: '构建完成',
    body: '耗时 3 分钟'
  });
  assert.deepEqual(defaultCopy({ status: 'completed' }), { title: '任务完成', body: undefined });
  assert.equal(defaultCopy({ status: 'failed' }).title, '任务出错');
  assert.equal(defaultCopy({ status: 'permission_request' }).title, '等待你的确认');
  assert.equal(defaultCopy({}).title, '等待你的确认');
});

test('showParams: kind + copy + duration snapshot assembled', () => {
  const snap = { ...baseSnap(), duration: 8000 };
  assert.deepEqual(showParams({ status: 'failed', taskId: 'T1', requestId: 'R1', title: '构建失败' }, snap), {
    kind: 'error',
    title: '构建失败',
    body: undefined,
    durationMs: 8000
  });
  assert.deepEqual(showParams({ status: 'permission_request', body: '允许执行?' }, snap), {
    kind: 'waiting',
    title: '等待你的确认',
    body: '允许执行?',
    durationMs: 8000
  });
});
