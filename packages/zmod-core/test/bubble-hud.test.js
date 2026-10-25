import test from 'node:test';
import assert from 'node:assert/strict';

// registered 标记与控制器状态都是模块级：每个用例用 query 参数加载独立实例
let instanceSeq = 0;
async function loadFreshModule() {
  return import(`../src/main/bubble-hud.js?instance=${++instanceSeq}`);
}

class FakeBrowserWindow {
  static instances = [];
  static reset() {
    this.instances.length = 0;
  }
  constructor(opts) {
    this.opts = opts;
    this.boundsCalls = [];
    this.loadURLCalls = [];
    this.jsCalls = [];
    this.topCalls = [];
    this.handlers = {};
    this.mouseIgnored = false;
    this.contentProtected = false;
    this.destroyed = false;
    this.hidden = true;
    this.hideThrows = false;
    this.loadURLImpl = () => Promise.resolve();
    this.webContents = {
      executeJavaScript: async (code) => {
        this.jsCalls.push(code);
      }
    };
    FakeBrowserWindow.instances.push(this);
  }
  setBounds(b) {
    this.boundsCalls.push(b);
  }
  async loadURL(url) {
    this.loadURLCalls.push(url);
    return this.loadURLImpl(url);
  }
  showInactive() {
    this.hidden = false;
  }
  setAlwaysOnTop(flag, level) {
    this.topCalls.push([flag, level]);
  }
  moveTop() {}
  setIgnoreMouseEvents(v) {
    this.mouseIgnored = v;
  }
  setContentProtection(v) {
    this.contentProtected = v;
  }
  on(ev, fn) {
    (this.handlers[ev] ??= []).push(fn);
  }
  hide() {
    if (this.hideThrows) throw new Error('hide boom');
    this.hidden = true;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const fn of this.handlers.closed || []) fn();
  }
  isDestroyed() {
    return this.destroyed;
  }
}

function makeScheduler() {
  const timers = new Map();
  let seq = 0;
  return {
    schedule: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    cancelSchedule: (id) => timers.delete(id),
    count: (ms) => [...timers.values()].filter((t) => t.ms === ms).length,
    runMs: (ms) => {
      const ids = [...timers.entries()].filter(([, t]) => t.ms === ms).map(([id]) => id);
      for (const id of ids) {
        const t = timers.get(id);
        if (!t) continue;
        timers.delete(id);
        t.fn();
      }
    }
  };
}

function makeScreen(overrides = {}) {
  const s = {
    displays: [
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { workArea: { x: 1920, y: 30, width: 1920, height: 1040 } }
    ],
    cursor: { x: 100, y: 100 },
    getCursorScreenPoint() {
      return s.cursor;
    },
    getDisplayNearestPoint(pt) {
      return (
        s.displays.find((d) => pt.x >= d.workArea.x && pt.x < d.workArea.x + d.workArea.width) ||
        s.displays[0]
      );
    },
    ...overrides
  };
  return s;
}

function makeGateway() {
  const handlers = new Map();
  return {
    handlers,
    register(method, handler) {
      handlers.set(method, handler);
    },
    async dispatch(method, params) {
      const h = handlers.get(method);
      if (!h) throw new Error(`no handler: ${method}`);
      return h(params || {});
    }
  };
}

function makeDeps(overrides = {}) {
  const scheduler = makeScheduler();
  return {
    deps: {
      platform: 'win32',
      BrowserWindow: FakeBrowserWindow,
      screen: makeScreen(),
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
      logger: { info() {}, warn() {}, debug() {} },
      ...overrides
    },
    scheduler
  };
}

const flush = () => new Promise((r) => setImmediate(r));

async function setup(overrides = {}) {
  const mod = await loadFreshModule();
  FakeBrowserWindow.reset();
  const { deps, scheduler } = makeDeps(overrides);
  const gw = makeGateway();
  const ok = mod.registerBubbleHud(gw, deps);
  return { mod, gw, deps, scheduler, ok };
}

function decodedHtml(win, call = 0) {
  const url = win.loadURLCalls[call];
  assert.ok(url.startsWith('data:text/html;base64,'), 'content must be a base64 data URL');
  return Buffer.from(url.slice('data:text/html;base64,'.length), 'base64').toString('utf8');
}

// 与实现同式的宽度估算（测试独立复算，防实现漂移）
function expectWidth(title, body = '') {
  const text = body ? `${title} · ${body}` : title;
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0) >= 0x2e80 ? 13.4 : 7.3;
  return Math.max(200, Math.round(20 + 10 + w + 36 + 20));
}

test('bubble hud suite', async (t) => {
  await t.test('registers three RPC methods and is idempotent', async () => {
    const { gw, ok } = await setup();
    assert.equal(ok, true);
    assert.deepEqual([...gw.handlers.keys()].sort(), ['bubble.hide', 'bubble.show', 'bubble.status']);

    const { mod, deps } = await setup();
    const gw2 = makeGateway();
    assert.equal(mod.registerBubbleHud(gw2, deps), false);
    assert.equal(gw2.handlers.size, 0);
  });

  await t.test('rejects invalid kind, missing title, non-string body', async () => {
    const { gw } = await setup();
    assert.deepEqual(await gw.dispatch('bubble.show', { kind: 'bogus', title: 'x' }), {
      ok: false,
      error: 'Invalid kind'
    });
    assert.deepEqual(await gw.dispatch('bubble.show', { kind: 'info' }), {
      ok: false,
      error: 'Title is required'
    });
    assert.deepEqual(await gw.dispatch('bubble.show', { kind: 'info', title: '   ' }), {
      ok: false,
      error: 'Title is required'
    });
    assert.deepEqual(await gw.dispatch('bubble.show', { kind: 'info', title: 'x', body: 42 }), {
      ok: false,
      error: 'Invalid body'
    });
    assert.equal(FakeBrowserWindow.instances.length, 0);
  });

  await t.test('clamps durationMs into [500, 30000], defaults 5000', async () => {
    const { gw, scheduler } = await setup();
    await gw.dispatch('bubble.show', { kind: 'info', title: 'T', durationMs: 1 });
    assert.equal(scheduler.count(500), 1);
    await gw.dispatch('bubble.show', { kind: 'info', title: 'T', durationMs: 99999 });
    assert.equal(scheduler.count(500), 0);
    assert.equal(scheduler.count(30000), 1);
    await gw.dispatch('bubble.show', { kind: 'info', title: 'T' });
    assert.equal(scheduler.count(30000), 0);
    assert.equal(scheduler.count(5000), 1);
  });

  await t.test('non-win32: shown:false, no window created', async () => {
    const { gw } = await setup({ platform: 'linux' });
    const r = await gw.dispatch('bubble.show', { kind: 'success', title: 'T' });
    assert.deepEqual(r, { ok: true, shown: false });
    assert.equal(FakeBrowserWindow.instances.length, 0);
    assert.deepEqual(await gw.dispatch('bubble.status', {}), {
      platform: 'linux',
      windowAlive: false
    });
  });

  await t.test('window creation params match the host recipe', async () => {
    const { gw } = await setup();
    await gw.dispatch('bubble.show', { kind: 'info', title: 'T' });
    assert.equal(FakeBrowserWindow.instances.length, 1);
    const win = FakeBrowserWindow.instances[0];
    const o = win.opts;
    assert.equal(o.alwaysOnTop, true);
    assert.equal(o.focusable, false);
    assert.equal(o.frame, false);
    assert.equal(o.hasShadow, false);
    assert.equal(o.resizable, false);
    assert.equal(o.show, false);
    assert.equal(o.skipTaskbar, true);
    assert.equal(o.transparent, true);
    assert.equal(o.backgroundColor, '#00000000');
    assert.equal(o.autoHideMenuBar, true);
    assert.equal(o.fullscreenable, false);
    assert.equal(o.maximizable, false);
    assert.equal(o.minimizable, false);
    assert.equal(o.movable, false);
    assert.deepEqual(o.webPreferences, {
      contextIsolation: true,
      devTools: false,
      nodeIntegration: false,
      sandbox: true
    });
    assert.equal(win.mouseIgnored, true);
    assert.equal(win.contentProtected, true);
    assert.deepEqual(win.topCalls, [[true, 'screen-saver']]);
  });

  await t.test('html: base64 data url, kind accents, escaping, theme media queries', async () => {
    const { gw } = await setup();
    const accents = {
      success: 'stroke="#16a34a"',
      error: 'stroke="#dc2626"',
      waiting: 'class="dots"',
      info: 'stroke="#2563eb"'
    };
    for (const [kind, marker] of Object.entries(accents)) {
      await gw.dispatch('bubble.show', { kind, title: `Title ${kind}`, body: 'detail' });
    }
    const win = FakeBrowserWindow.instances[0];
    assert.equal(win.loadURLCalls.length, 4);
    for (const [i, kind] of Object.keys(accents).entries()) {
      const html = decodedHtml(win, i);
      assert.ok(html.includes(accents[kind]), `kind ${kind} accent marker missing`);
      assert.ok(html.includes(`Title ${kind} · detail`), `kind ${kind} text missing`);
      if (kind === 'waiting') assert.ok(html.includes('class="dot"'));
      assert.ok(html.includes('data-state="active"'));
      assert.ok(html.includes("default-src 'none'; style-src 'unsafe-inline'"));
      assert.ok(html.includes('@media (prefers-color-scheme: dark)'));
      assert.ok(html.includes('rgba(255, 255, 255, 0.96)'));
      assert.ok(html.includes('rgba(35, 38, 43, 0.96)'));
      assert.ok(html.includes('@media (prefers-reduced-motion: reduce)'));
      assert.ok(html.includes('"Segoe UI Variable", "Segoe UI", sans-serif'));
    }
  });

  await t.test('html: <script> injection is escaped', async () => {
    const { gw } = await setup();
    await gw.dispatch('bubble.show', {
      kind: 'error',
      title: '<script>alert(1)</script>',
      body: '<img src=x onerror=alert(2)>'
    });
    const html = decodedHtml(FakeBrowserWindow.instances[0]);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'));
  });

  await t.test('html: title/body truncated to 120/160 chars', async () => {
    const { gw } = await setup();
    await gw.dispatch('bubble.show', {
      kind: 'info',
      title: 'a'.repeat(130),
      body: 'b'.repeat(200)
    });
    const html = decodedHtml(FakeBrowserWindow.instances[0]);
    assert.ok(html.includes('a'.repeat(120)));
    assert.ok(!html.includes('a'.repeat(121)));
    assert.ok(html.includes('b'.repeat(160)));
    assert.ok(!html.includes('b'.repeat(161)));
  });

  await t.test('positions top-center of the cursor display workArea', async () => {
    const { gw } = await setup({ screen: makeScreen({ cursor: { x: 2500, y: 500 } }) });
    await gw.dispatch('bubble.show', { kind: 'info', title: 'x'.repeat(100) });
    const b = FakeBrowserWindow.instances[0].boundsCalls[0];
    const w = expectWidth('x'.repeat(100));
    assert.equal(b.width, w);
    assert.equal(b.height, 56);
    assert.equal(b.x, 1920 + Math.round((1920 - w) / 2));
    assert.equal(b.y, 30 + 12 - 6);
  });

  await t.test('narrow text clamps to minimum width 200', async () => {
    const { gw } = await setup();
    await gw.dispatch('bubble.show', { kind: 'info', title: 'Hi' });
    const b = FakeBrowserWindow.instances[0].boundsCalls[0];
    assert.equal(b.width, 200);
    assert.equal(b.x, 0 + Math.round((1920 - 200) / 2));
    assert.equal(b.y, 0 + 12 - 6);
  });

  await t.test('single window reuse: reposition + reload + hide timer reset', async () => {
    const { gw, scheduler } = await setup();
    await gw.dispatch('bubble.show', { kind: 'info', title: 'x'.repeat(100) });
    await gw.dispatch('bubble.show', { kind: 'success', title: 'y'.repeat(50), durationMs: 8000 });
    assert.equal(FakeBrowserWindow.instances.length, 1);
    const win = FakeBrowserWindow.instances[0];
    assert.equal(win.loadURLCalls.length, 2);
    assert.equal(win.boundsCalls.length, 2);
    assert.equal(win.boundsCalls[1].width, expectWidth('y'.repeat(50)));
    assert.equal(scheduler.count(5000), 0, 'first hide timer must be cancelled');
    assert.equal(scheduler.count(8000), 1);
    assert.equal(win.hidden, false);
  });

  await t.test('leaving: duration elapses → leaving state → 120ms → hide', async () => {
    const { gw, scheduler } = await setup();
    await gw.dispatch('bubble.show', { kind: 'info', title: 'T', durationMs: 500 });
    const win = FakeBrowserWindow.instances[0];
    scheduler.runMs(500);
    assert.ok(win.jsCalls.some((c) => c.includes('leaving')), 'must enter leaving state');
    assert.equal(scheduler.count(120), 1);
    scheduler.runMs(120);
    assert.equal(win.hidden, true);
    assert.equal(win.destroyed, false);
  });

  await t.test('hide failure during leave falls back to destroy', async () => {
    const { gw, scheduler } = await setup();
    await gw.dispatch('bubble.show', { kind: 'info', title: 'T', durationMs: 500 });
    const win = FakeBrowserWindow.instances[0];
    win.hideThrows = true;
    scheduler.runMs(500);
    scheduler.runMs(120);
    assert.equal(win.destroyed, true);
    assert.deepEqual(await gw.dispatch('bubble.status', {}), {
      platform: 'win32',
      windowAlive: false
    });
  });

  await t.test('bubble.hide RPC cancels timers and starts leaving', async () => {
    const { gw, scheduler } = await setup();
    await gw.dispatch('bubble.show', { kind: 'info', title: 'T', durationMs: 30000 });
    assert.equal(scheduler.count(30000), 1);
    assert.deepEqual(await gw.dispatch('bubble.hide', {}), { ok: true });
    assert.equal(scheduler.count(30000), 0, 'auto-hide timer cancelled by explicit hide');
    assert.equal(scheduler.count(120), 1);
    const win = FakeBrowserWindow.instances[0];
    scheduler.runMs(120);
    assert.equal(win.hidden, true);
  });

  await t.test('load failure (injected rejection): discard + retry rebuilds', async () => {
    const { gw, scheduler } = await setup();
    await gw.dispatch('bubble.show', { kind: 'success', title: 'first' });
    const win1 = FakeBrowserWindow.instances[0];
    win1.loadURLImpl = () => Promise.reject(new Error('load boom'));
    const r = await gw.dispatch('bubble.show', { kind: 'success', title: 'second' });
    assert.equal(r.ok, false);
    assert.match(r.error, /load boom/);
    assert.equal(win1.destroyed, true, 'failed window must be discarded');
    assert.equal(scheduler.count(250), 1, 'retry must be scheduled at 250ms');

    scheduler.runMs(250);
    await flush();
    assert.equal(FakeBrowserWindow.instances.length, 2, 'retry must rebuild a window');
    const win2 = FakeBrowserWindow.instances[1];
    assert.equal(win2.destroyed, false);
    assert.equal(win2.loadURLCalls.length, 1);
    assert.ok(decodedHtml(win2).includes('second'), 'retry must re-show the last payload');
    assert.equal(win2.hidden, false);
    assert.deepEqual(await gw.dispatch('bubble.status', {}), {
      platform: 'win32',
      windowAlive: true
    });
  });

  await t.test('ERR_ABORTED (superseded by a newer show): ok, no discard, no retry', async () => {
    const { gw, scheduler } = await setup();
    await gw.dispatch('bubble.show', { kind: 'success', title: 'first' });
    const win1 = FakeBrowserWindow.instances[0];
    const aborted = Object.assign(new Error('ERR_ABORTED: loading was superseded'), {
      code: 'ERR_ABORTED'
    });
    win1.loadURLImpl = () => Promise.reject(aborted);
    const r = await gw.dispatch('bubble.show', { kind: 'success', title: 'second' });
    assert.deepEqual(r, { ok: true, shown: true });
    assert.equal(win1.destroyed, false, 'superseded load must not discard the window');
    assert.equal(scheduler.count(250), 0, 'no retry must be scheduled');
  });

  await t.test('external close clears window state without throwing', async () => {
    const { gw } = await setup();
    await gw.dispatch('bubble.show', { kind: 'info', title: 'T' });
    const win = FakeBrowserWindow.instances[0];
    win.destroy();
    assert.deepEqual(await gw.dispatch('bubble.status', {}), {
      platform: 'win32',
      windowAlive: false
    });
    // 后续 show 走全新创建而非复用已销毁窗口
    await gw.dispatch('bubble.show', { kind: 'info', title: 'again' });
    assert.equal(FakeBrowserWindow.instances.length, 2);
  });
});
