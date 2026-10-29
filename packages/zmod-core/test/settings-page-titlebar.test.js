import test from 'node:test';
import assert from 'node:assert/strict';

// settings-page.js 模块顶层无 DOM 依赖，可在 Node 单测中导入。
// 这里用最小 mock DOM 只测标题栏 z-index 提升状态机：JSDOM 不在依赖里，
// 且 -webkit-app-region 拖拽行为本就无法离线复现——只验证发现/提升/还原/幂等。
const { findTitleBarContainers, raiseTitleBar, restoreTitleBar } =
  await import('../src/renderer/settings-page.js');

/* ---- 最小 mock DOM ----
   节点 = { parentElement, isConnected, children, style, getAttribute, _pos, _z }。
   getComputedStyle 语义：inline zIndex 非空则优先，否则类值 _z，无则 'auto'。
   document.querySelector 支持 button[aria-label="…"] 与 [data-zmod-settings-overlay]。 */

function node({ label = null, pos = 'static', z = 'auto', inlineZ = null, connected = true, overlay = false } = {}) {
  const style = {};
  if (inlineZ != null) style.zIndex = inlineZ;
  style.removeProperty = (name) => {
    if (String(name).replace(/-[a-z]/g, (c) => c.slice(1).toUpperCase()) === 'zIndex') style.zIndex = '';
  };
  const el = {
    parentElement: null,
    isConnected: connected,
    style,
    getAttribute: (n) => (n === 'aria-label' ? label : null),
    _pos: pos,
    _z: z,
    _overlay: overlay
  };
  el.contains = (other) => {
    for (let n = other; n; n = n.parentElement) if (n === el) return true;
    return false;
  };
  return el;
}

function link(...els) {
  for (let i = 0; i < els.length - 1; i++) els[i].parentElement = els[i + 1];
  return els[0];
}

function installGlobals(buttons, { html, body, overlay = null } = {}) {
  const byLabel = new Map();
  for (const b of buttons) {
    const l = b.getAttribute('aria-label');
    if (l && !byLabel.has(l)) byLabel.set(l, b);
  }
  globalThis.document = {
    documentElement: html,
    body,
    querySelectorAll: (sel) => {
      const m = /aria-label="([^"]+)"/.exec(sel);
      const hit = m && byLabel.get(m[1]);
      return hit ? [hit] : [];
    },
    querySelector: (sel) => (sel === '[data-zmod-settings-overlay]' ? overlay : null)
  };
  globalThis.getComputedStyle = (el) => ({
    position: el._pos,
    zIndex: el.style.zIndex ? el.style.zIndex : el._z
  });
}

function uninstallGlobals() {
  delete globalThis.document;
  delete globalThis.getComputedStyle;
}

/** 真机形态：body > titleBarRoot(fixed, 类 z-10) > { 常规组 > 最小化按钮, 浮动组(absolute z-30) > 关闭按钮 } */
function realShapeTree() {
  const html = node();
  const body = node();
  body.parentElement = html;
  const titleBarRoot = node({ pos: 'fixed', z: '10' });
  titleBarRoot.parentElement = body;
  const regularGroup = node();
  const btnMin = link(node({ label: '最小化窗口' }), regularGroup, titleBarRoot);
  const floatGroup = node({ pos: 'absolute', z: '30' });
  const btnClose = link(node({ label: '关闭窗口' }), floatGroup, titleBarRoot);
  return { html, body, titleBarRoot, btnMin, btnClose };
}

test('发现: 真机形态——两组按钮共享 fixed z-10 根容器，去重为单目标', () => {
  const t = realShapeTree();
  installGlobals([t.btnMin, t.btnClose], t);
  try {
    assert.deepEqual(findTitleBarContainers(), [t.titleBarRoot]);
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});

test('提升/还原: inline 原值为空 → 提到 70，还原移除属性（类值语义回归）', () => {
  const t = realShapeTree();
  installGlobals([t.btnMin], t);
  try {
    raiseTitleBar();
    assert.equal(t.titleBarRoot.style.zIndex, '70');
    restoreTitleBar();
    assert.equal(t.titleBarRoot.style.zIndex, '');
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});

test('发现: 定位祖先均不带 z-index → 退回最近定位祖先（relative z-auto 容器）', () => {
  // demo 宿主形态：常规按钮挂在 relative z-auto 的 HEADER 上，祖先无任何带 z 的定位元素
  const html = node();
  const body = node();
  body.parentElement = html;
  const shell = node({ z: '20' }); // static + 类 z：z-index 不生效，不构成合法目标
  shell.parentElement = body;
  const header = node({ pos: 'relative' });
  header.parentElement = shell;
  const btn = link(node({ label: '最大化或还原窗口' }), header);
  installGlobals([btn], { html, body });
  try {
    assert.deepEqual(findTitleBarContainers(), [header]);
    raiseTitleBar();
    assert.equal(header.style.zIndex, '70');
    assert.equal(shell.style.zIndex ?? '', '');
    restoreTitleBar();
    assert.equal(header.style.zIndex, '');
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});

test('发现: 带外层定位祖先带 z-index → 抬最外层（罩住两组）', () => {
  const t = realShapeTree();
  installGlobals([t.btnClose], t);
  try {
    assert.deepEqual(findTitleBarContainers(), [t.titleBarRoot]);
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});

test('发现: 含 overlay 的 z 层祖先被排除 → 退回最近不含 overlay 的定位祖先', () => {
  // demo 宿主另一关键形态：全窗口 z-10 层同时包含按钮与设置 frame（overlay），
  // 抬它会把 overlay 一起抬走——必须跳过，落到最近定位祖先 HEADER。
  const html = node();
  const body = node();
  body.parentElement = html;
  const zLayer = node({ pos: 'absolute', z: '10' });
  zLayer.parentElement = body;
  const header = node({ pos: 'relative' });
  header.parentElement = zLayer;
  const btn = link(node({ label: '最小化窗口' }), header, zLayer);
  const overlayEl = node({ overlay: true });
  overlayEl.parentElement = zLayer; // overlay 在同一 z 层内
  installGlobals([btn], { html, body, overlay: overlayEl });
  try {
    assert.deepEqual(findTitleBarContainers(overlayEl), [header]);
    raiseTitleBar(overlayEl);
    assert.equal(header.style.zIndex, '70');
    assert.equal(zLayer.style.zIndex ?? '', '');
    restoreTitleBar();
    assert.equal(header.style.zIndex, '');
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});

test('发现: 两组按钮不同根 → 返回多个目标，各自提升与还原', () => {
  // demo 宿主实测形态：常规组在 relative z-auto HEADER，浮动组自带 absolute z-30
  const html = node();
  const body = node();
  body.parentElement = html;
  const header = node({ pos: 'relative' });
  header.parentElement = body;
  const btnMin = link(node({ label: '最小化窗口' }), header);
  const floatGroup = node({ pos: 'absolute', z: '30' });
  floatGroup.parentElement = body;
  const btnClose = link(node({ label: '关闭窗口' }), floatGroup);
  installGlobals([btnMin, btnClose], { html, body });
  try {
    const targets = findTitleBarContainers();
    assert.equal(targets.length, 2);
    assert.ok(targets.includes(header) && targets.includes(floatGroup));
    raiseTitleBar();
    assert.equal(header.style.zIndex, '70');
    assert.equal(floatGroup.style.zIndex, '70');
    restoreTitleBar();
    assert.equal(header.style.zIndex, '');
    assert.equal(floatGroup.style.zIndex, ''); // 浮动组类值 z-30 语义回归
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});

test('提升/还原: 记录的 inline 原值精确还原（不落到类值）', () => {
  const html = node();
  const body = node();
  body.parentElement = html;
  const bar = node({ pos: 'fixed', inlineZ: '5' });
  bar.parentElement = body;
  const btn = link(node({ label: '关闭窗口' }), bar);
  installGlobals([btn], { html, body });
  try {
    raiseTitleBar();
    assert.equal(bar.style.zIndex, '70');
    restoreTitleBar();
    assert.equal(bar.style.zIndex, '5');
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});

test('幂等: 重复提升不覆盖记录的原值，重复还原无害', () => {
  const t = realShapeTree();
  installGlobals([t.btnMin], t);
  try {
    raiseTitleBar();
    raiseTitleBar();
    raiseTitleBar();
    assert.equal(t.titleBarRoot.style.zIndex, '70');
    restoreTitleBar();
    assert.equal(t.titleBarRoot.style.zIndex, '');
    restoreTitleBar();
    assert.equal(t.titleBarRoot.style.zIndex, '');
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});

test('幂等: 容器随旧 DOM 销毁后再提升 → 按新 DOM 重新发现并记录', () => {
  const t1 = realShapeTree();
  installGlobals([t1.btnMin], t1);
  raiseTitleBar();
  assert.equal(t1.titleBarRoot.style.zIndex, '70');
  t1.titleBarRoot.isConnected = false; // 对话框重挂载：旧根容器断连
  const t2 = realShapeTree();
  installGlobals([t2.btnMin], t2);
  try {
    raiseTitleBar();
    assert.equal(t2.titleBarRoot.style.zIndex, '70');
    restoreTitleBar();
    assert.equal(t2.titleBarRoot.style.zIndex, '');
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});

test('防御: 找不到窗口控制按钮 / 无定位祖先 → no-op 不抛错', () => {
  const html = node();
  const body = node();
  body.parentElement = html;
  installGlobals([], { html, body });
  try {
    assert.deepEqual(findTitleBarContainers(), []);
    raiseTitleBar();
    restoreTitleBar();
    const btn = node({ label: '最小化窗口' });
    btn.parentElement = body; // 全链 static，无定位祖先
    installGlobals([btn], { html, body });
    assert.deepEqual(findTitleBarContainers(), []);
    raiseTitleBar();
    restoreTitleBar();
    assert.equal(btn.style.zIndex ?? '', '');
  } finally {
    restoreTitleBar();
    uninstallGlobals();
  }
});
