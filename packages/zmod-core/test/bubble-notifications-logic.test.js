import test from 'node:test';
import assert from 'node:assert/strict';

const { STATUS_KIND, STATUS_SWITCH, dedupeKey, shouldDedupePass, shouldShow, defaultCopy, showParams, computeBubbleStyle } =
  await import('../../../plugins/bubble-notifications/lib.js');

const baseSnap = () => ({
  enabled: true,
  onCompleted: true,
  onFailed: true,
  onWaiting: true,
  duration: 5000,
  focusShow: false,
  position: 'top-center',
  margin: 12,
  scale: 100,
  theme: 'auto'
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
    durationMs: 8000,
    position: 'top-center',
    margin: 12,
    scale: 1,
    theme: 'auto'
  });
  assert.deepEqual(showParams({ status: 'permission_request', body: '允许执行?' }, snap), {
    kind: 'waiting',
    title: '等待你的确认',
    body: '允许执行?',
    durationMs: 8000,
    position: 'top-center',
    margin: 12,
    scale: 1,
    theme: 'auto'
  });
});

test('showParams: appearance keys pass through, scale converts % → multiplier', () => {
  const snap = { ...baseSnap(), position: 'bottom-left', margin: 24, scale: 130, theme: 'dark' };
  assert.deepEqual(showParams({ status: 'completed', taskId: 'T1', requestId: 'R1' }, snap), {
    kind: 'success',
    title: '任务完成',
    body: undefined,
    durationMs: 5000,
    position: 'bottom-left',
    margin: 24,
    scale: 1.3,
    theme: 'dark'
  });
  // 边界刻度：60% → 0.6、160% → 1.6（与 bubble-hud 钳制边界一致）
  assert.equal(showParams({ status: 'completed' }, { ...baseSnap(), scale: 60 }).scale, 0.6);
  assert.equal(showParams({ status: 'completed' }, { ...baseSnap(), scale: 160 }).scale, 1.6);
});

test('showParams: legacy snapshot without appearance keys degrades gracefully', () => {
  const legacy = { duration: 8000 };
  const params = showParams({ status: 'completed', taskId: 'T1', requestId: 'R1' }, legacy);
  assert.equal(params.position, undefined);
  assert.equal(params.margin, undefined);
  assert.equal(params.scale, undefined);
  assert.equal(params.theme, undefined);
  assert.equal(params.durationMs, 8000);
  // 非数值 scale 不做除法，保持 undefined 让服务端回退默认
  assert.equal(showParams({ status: 'completed' }, { ...baseSnap(), scale: 'big' }).scale, undefined);
});

test('computeBubbleStyle: preset vs coord modes and offsets', () => {
  // 1. 默认 preset top-center
  const defStyle = computeBubbleStyle(baseSnap());
  assert.equal(defStyle.left, '50%');
  assert.equal(defStyle.top, '12px');
  assert.equal(defStyle.transform, 'translate(-50%, 0) translate(0px, 0px) scale(1)');

  // 2. preset bottom-right + margin 20 + offset + scale 1.2
  const brStyle = computeBubbleStyle({
    coordMode: 'preset',
    position: 'bottom-right',
    margin: 20,
    offsetX: 10,
    offsetY: -5,
    scale: 120
  });
  assert.equal(brStyle.left, 'calc(100% - 20px)');
  assert.equal(brStyle.top, 'calc(100% - 20px)');
  assert.equal(brStyle.transform, 'translate(-100%, -100%) translate(10px, -5px) scale(1.2)');

  // 3. coord 自定义百分比坐标
  const coordStyle = computeBubbleStyle({
    coordMode: 'coord',
    coordX: 30,
    coordY: 70,
    offsetX: -15,
    offsetY: 25,
    scale: 90
  });
  assert.equal(coordStyle.left, '30%');
  assert.equal(coordStyle.top, '70%');
  assert.equal(coordStyle.transform, 'translate(-50%, -50%) translate(-15px, 25px) scale(0.9)');
});
