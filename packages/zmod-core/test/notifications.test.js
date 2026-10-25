import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { NOTIFY_CH, NOTIFY_FWD } from '../src/main/notifications.js';

// tapInstalled 是模块级状态：每个用例用 query 参数加载独立模块实例，互不污染
let instanceSeq = 0;
async function loadFreshModule() {
  return import(`../src/main/notifications.js?instance=${++instanceSeq}`);
}

function makeIpcMain() {
  return new EventEmitter();
}

function makeSender(sink) {
  return {
    send: (channel, payload) => sink.push({ channel, payload })
  };
}

test('notification tap suite', async (t) => {
  await t.test('forwards normalized payload to the sender only', async () => {
    const { installNotificationTap } = await loadFreshModule();
    const ipcMain = makeIpcMain();
    assert.equal(installNotificationTap({ ipcMain, getFocused: () => true }), true);
    const sinkA = [];
    const sinkB = [];
    const payload = {
      taskId: 'task-1',
      status: 'completed',
      requestId: 'req-42',
      title: 'Done',
      body: 'Agent finished'
    };
    ipcMain.emit(NOTIFY_CH, { sender: makeSender(sinkA) }, payload);
    ipcMain.emit(NOTIFY_CH, { sender: makeSender(sinkB) }, payload);

    assert.equal(sinkA.length, 1);
    assert.equal(sinkB.length, 1);
    for (const sink of [sinkA, sinkB]) {
      assert.equal(sink[0].channel, NOTIFY_FWD);
      const fwd = sink[0].payload;
      assert.equal(fwd.status, payload.status);
      assert.equal(fwd.taskId, payload.taskId);
      assert.equal(fwd.requestId, payload.requestId);
      assert.equal(fwd.title, payload.title);
      assert.equal(fwd.body, payload.body);
      assert.equal(typeof fwd.ts, 'number');
      assert.equal(fwd.anyFocused, true);
    }
    // sender-targeted: each emit builds its own forward object
    assert.notEqual(sinkA[0].payload, sinkB[0].payload);
    assert.deepEqual(Object.keys(sinkA[0].payload).sort(), [
      'anyFocused',
      'body',
      'requestId',
      'status',
      'taskId',
      'title',
      'ts'
    ]);
  });

  await t.test('double install is idempotent: one forward per emit', async () => {
    const { installNotificationTap, notificationTapStatus: status } = await loadFreshModule();
    const ipcMain = makeIpcMain();
    assert.equal(installNotificationTap({ ipcMain, getFocused: () => false }), true);
    assert.equal(installNotificationTap({ ipcMain, getFocused: () => false }), true);
    const sink = [];
    ipcMain.emit(NOTIFY_CH, { sender: makeSender(sink) }, { status: 'running', taskId: 't' });
    assert.equal(sink.length, 1);
    assert.deepEqual(status(), { installed: true });
  });

  await t.test('getFocused throwing degrades to anyFocused:false and still forwards', async () => {
    const { installNotificationTap } = await loadFreshModule();
    const ipcMain = makeIpcMain();
    assert.equal(
      installNotificationTap({
        ipcMain,
        getFocused: () => {
          throw new Error('boom');
        }
      }),
      true
    );
    const sink = [];
    ipcMain.emit(
      NOTIFY_CH,
      { sender: makeSender(sink) },
      { status: 'failed', taskId: 't2', title: 'Err', body: 'nope' }
    );
    assert.equal(sink.length, 1);
    assert.equal(sink[0].payload.anyFocused, false);
    assert.equal(sink[0].payload.status, 'failed');
    assert.equal(sink[0].payload.taskId, 't2');
  });

  await t.test('non-object payload: no forward, no throw', async () => {
    const { installNotificationTap } = await loadFreshModule();
    const ipcMain = makeIpcMain();
    assert.equal(installNotificationTap({ ipcMain, getFocused: () => false }), true);
    const sink = [];
    const sender = makeSender(sink);
    for (const bad of [null, undefined, 42, 'str', true]) {
      assert.doesNotThrow(() => ipcMain.emit(NOTIFY_CH, { sender }, bad));
    }
    assert.equal(sink.length, 0);
  });

  await t.test('sender without send() does not throw', async () => {
    const { installNotificationTap } = await loadFreshModule();
    const ipcMain = makeIpcMain();
    assert.equal(installNotificationTap({ ipcMain, getFocused: () => false }), true);
    assert.doesNotThrow(() => ipcMain.emit(NOTIFY_CH, {}, { status: 'x' }));
    assert.doesNotThrow(() => ipcMain.emit(NOTIFY_CH, { sender: {} }, { status: 'x' }));
  });
});
