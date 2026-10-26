import test from 'node:test';
import assert from 'node:assert/strict';

// 纯视图合并层，不依赖 window / sdk 协议 import，可全离线单测。
const {
  mergeMarketView,
  compareSemver,
  evaluateZmodEngine,
  CATEGORY_LABELS,
  filterMarketRows,
  normalizeInstallUrl
} = await import('../src/renderer/market-view.js');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function regEntry({ id, version, manifest = {}, url } = {}) {
  return {
    id,
    version,
    url: url || `https://cdn.example.com/${id}.zip`,
    shasum: 'deadbeef',
    manifest: { id, name: `Name ${id}`, version, description: `${id} 的描述`, ...manifest }
  };
}

function localDef({ id, version = '1.0.0', name } = {}) {
  return { id, name: name || `Local ${id}`, version, description: '本地插件' };
}

// ---------------------------------------------------------------------------
// compareSemver —— 内联最小 semver
// ---------------------------------------------------------------------------

test('compareSemver: prerelease 低于同版本 release（1.0.0-beta < 1.0.0）', () => {
  assert.equal(compareSemver('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta'), 1);
});

test('compareSemver: 数值逐段比较（1.2.10 > 1.2.9，不按字符串序）', () => {
  assert.equal(compareSemver('1.2.10', '1.2.9'), 1);
  assert.equal(compareSemver('1.2.9', '1.2.10'), -1);
});

test('compareSemver: 相等返回 0；不可解析返回 null', () => {
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('2.0.0', '2.0.0+build.1'), 0); // +build 忽略
  assert.equal(compareSemver('abc', '1.0.0'), null);
  assert.equal(compareSemver('1.0.0', ''), null);
});

test('compareSemver: prerelease 标识符按数字/字母数字规则比较', () => {
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1); // 数字段 < 字母数字段
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha'), 1); // 长前缀更大
});

// ---------------------------------------------------------------------------
// evaluateZmodEngine —— 简化范围策略
// ---------------------------------------------------------------------------

test('evaluateZmodEngine: >=9.9.9 对 1.0.0-beta → 不兼容并给出原因', () => {
  const r = evaluateZmodEngine({ zmod: '>=9.9.9' }, '1.0.0-beta');
  assert.equal(r.ok, false);
  assert.match(r.reason, />=9\.9\.9/);
  assert.match(r.reason, /1\.0\.0-beta/);
});

test('evaluateZmodEngine: >= 满足/边界相等 → 兼容', () => {
  assert.equal(evaluateZmodEngine({ zmod: '>=1.0.0' }, '1.2.0').ok, true);
  assert.equal(evaluateZmodEngine({ zmod: '>=1.0.0' }, '1.0.0').ok, true);
  assert.equal(evaluateZmodEngine({ zmod: '>=1.0.0-beta' }, '1.0.0-beta').ok, true);
});

test("evaluateZmodEngine: '*' 与空 engine 放行；engine.zcode 不查", () => {
  assert.equal(evaluateZmodEngine({ zmod: '*' }, '0.0.1').ok, true);
  assert.equal(evaluateZmodEngine({}, '0.0.1').ok, true);
  assert.equal(evaluateZmodEngine(null, '0.0.1').ok, true);
  assert.equal(evaluateZmodEngine({ zcode: '>=1.0.0' }, '0.0.1').ok, true);
});

test('evaluateZmodEngine: 非受支持形态(^ ~ 精确)放行主进程兜底；zmodVersion 缺省放行', () => {
  assert.equal(evaluateZmodEngine({ zmod: '^2.0.0' }, '1.0.0').ok, true);
  assert.equal(evaluateZmodEngine({ zmod: '~1.2.3' }, '1.0.0').ok, true);
  assert.equal(evaluateZmodEngine({ zmod: '2.0.0' }, '1.0.0').ok, true);
  assert.equal(evaluateZmodEngine({ zmod: '>=9.9.9' }, undefined).ok, true);
  assert.equal(evaluateZmodEngine({ zmod: '>=9.9.9' }, '').ok, true);
});

// ---------------------------------------------------------------------------
// mergeMarketView —— 行状态合并
// ---------------------------------------------------------------------------

test('mergeMarketView: 未安装 → not-installed，installedVersion 为 null', () => {
  const { rows, localOnly } = mergeMarketView([], [regEntry({ id: 'a', version: '1.0.0' })], {
    zmodVersion: '1.0.0-beta'
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'not-installed');
  assert.equal(rows[0].installedVersion, null);
  assert.equal(rows[0].version, '1.0.0');
  assert.deepEqual(localOnly, []);
});

test('mergeMarketView: 已装同版本 → installed', () => {
  const { rows } = mergeMarketView(
    [localDef({ id: 'a', version: '1.2.3' })],
    [regEntry({ id: 'a', version: '1.2.3' })],
    {}
  );
  assert.equal(rows[0].state, 'installed');
  assert.equal(rows[0].installedVersion, '1.2.3');
});

test('mergeMarketView: registry 版本更高 → update-available', () => {
  const { rows } = mergeMarketView(
    [localDef({ id: 'a', version: '1.2.3' })],
    [regEntry({ id: 'a', version: '1.3.0' })],
    {}
  );
  assert.equal(rows[0].state, 'update-available');
});

test('mergeMarketView: registry 版本更低不算更新（防降级）', () => {
  const { rows } = mergeMarketView(
    [localDef({ id: 'a', version: '1.2.3' })],
    [regEntry({ id: 'a', version: '1.1.0' })],
    {}
  );
  assert.equal(rows[0].state, 'installed');
});

test('mergeMarketView: prerelease 升级到 release 算可更新；版本不可比按已装', () => {
  const up = mergeMarketView(
    [localDef({ id: 'a', version: '1.0.0-beta' })],
    [regEntry({ id: 'a', version: '1.0.0' })],
    {}
  );
  assert.equal(up.rows[0].state, 'update-available');
  const unk = mergeMarketView(
    [localDef({ id: 'a', version: 'not-a-semver' })],
    [regEntry({ id: 'a', version: '2.0.0' })],
    {}
  );
  assert.equal(unk.rows[0].state, 'installed');
});

test('mergeMarketView: engine >=9.9.9 → engineOk=false 带 reason；engine 缺省放行', () => {
  const { rows } = mergeMarketView(
    [],
    [
      regEntry({ id: 'a', version: '1.0.0', manifest: { engine: { zmod: '>=9.9.9' } } }),
      regEntry({ id: 'b', version: '1.0.0' }),
      regEntry({ id: 'c', version: '1.0.0', manifest: { engine: { zmod: '*', zcode: '>=99.0.0' } } })
    ],
    { zmodVersion: '1.0.0-beta' }
  );
  assert.equal(rows[0].engineOk, false);
  assert.match(rows[0].engineReason, />=9\.9\.9/);
  assert.equal(rows[1].engineOk, true);
  assert.equal(rows[2].engineOk, true); // zcode 范围不查
});

test('mergeMarketView: 行字段透传 category/permissions/url，manifest 缺失回退 id', () => {
  const { rows } = mergeMarketView(
    [],
    [
      regEntry({
        id: 'a',
        version: '1.0.0',
        manifest: { category: 'fun', permissions: ['dom.patch', 'net.fetch'] }
      }),
      { id: 'bare', version: '0.1.0', url: 'https://x/bare.zip' }
    ],
    {}
  );
  assert.equal(rows[0].category, 'fun');
  assert.deepEqual(rows[0].permissions, ['dom.patch', 'net.fetch']);
  assert.equal(rows[0].url, 'https://cdn.example.com/a.zip');
  assert.equal(rows[1].name, 'bare'); // 无 manifest → 名称回退 id
  assert.deepEqual(rows[1].permissions, []);
  assert.equal(rows[1].category, null);
});

test('mergeMarketView: localOnly 提取本地独有 defs，且不混入 rows', () => {
  const { rows, localOnly } = mergeMarketView(
    [localDef({ id: 'a', version: '1.0.0' }), localDef({ id: 'local-only', version: '0.2.0' })],
    [regEntry({ id: 'a', version: '1.0.0' })],
    {}
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(localOnly.map((d) => d.id), ['local-only']);
});

test('mergeMarketView: 非法输入与非法定义容错', () => {
  const { rows, localOnly } = mergeMarketView(null, [null, { id: 'a', version: '1.0.0' }], {});
  assert.equal(rows.length, 1);
  assert.deepEqual(localOnly, []);
  assert.deepEqual(mergeMarketView([{ nope: true }], []).rows, []);
});

test('mergeMarketView: 透传 author 与 repo，缺失时回退 null', () => {
  const { rows } = mergeMarketView(
    [],
    [
      regEntry({
        id: 'with-meta',
        version: '1.0.0',
        manifest: { author: 'ZMod Team', repo: 'https://github.com/org/repo' }
      }),
      regEntry({ id: 'no-meta', version: '1.0.0' })
    ],
    {}
  );
  assert.equal(rows[0].author, 'ZMod Team');
  assert.equal(rows[0].repo, 'https://github.com/org/repo');
  assert.equal(rows[1].author, null);
  assert.equal(rows[1].repo, null);
});

// ---------------------------------------------------------------------------
// CATEGORY_LABELS & filterMarketRows
// ---------------------------------------------------------------------------

test('CATEGORY_LABELS: 包含预设分类标签', () => {
  assert.deepEqual(CATEGORY_LABELS, {
    all: '全部',
    appearance: '外观',
    productivity: '效率'
  });
});

test('filterMarketRows: 按分类与关键字（大小写不敏感）过滤，及组合条件', () => {
  const sampleRows = [
    {
      id: 'acrylic-theme',
      name: '亚克力透明材质',
      description: '赋予主窗口高斯模糊外观',
      category: 'appearance'
    },
    {
      id: 'quota-hud',
      name: '额度浮窗 HUD',
      description: '实时展示百炼与 GLM 额度',
      category: 'productivity'
    },
    {
      id: 'notification-sounds',
      name: '任务提示音',
      description: '完成或出错时播放音效',
      category: 'productivity'
    }
  ];

  // 默认全部
  assert.equal(filterMarketRows(sampleRows).length, 3);
  assert.equal(filterMarketRows(sampleRows, { category: 'all', keyword: '' }).length, 3);

  // 仅分类过滤
  assert.deepEqual(
    filterMarketRows(sampleRows, { category: 'appearance' }).map((r) => r.id),
    ['acrylic-theme']
  );
  assert.deepEqual(
    filterMarketRows(sampleRows, { category: 'productivity' }).map((r) => r.id),
    ['quota-hud', 'notification-sounds']
  );

  // 关键字匹配 id / name / description / category（大小写不敏感）
  assert.deepEqual(
    filterMarketRows(sampleRows, { keyword: 'ACRYLIC' }).map((r) => r.id),
    ['acrylic-theme']
  );
  assert.deepEqual(
    filterMarketRows(sampleRows, { keyword: 'hud' }).map((r) => r.id),
    ['quota-hud']
  );
  assert.deepEqual(
    filterMarketRows(sampleRows, { keyword: '播放音效' }).map((r) => r.id),
    ['notification-sounds']
  );

  // 分类 + 关键字组合
  assert.deepEqual(
    filterMarketRows(sampleRows, { category: 'productivity', keyword: '额度' }).map((r) => r.id),
    ['quota-hud']
  );
  assert.deepEqual(
    filterMarketRows(sampleRows, { category: 'appearance', keyword: '额度' }),
    []
  );

  // 非法输入容错
  assert.deepEqual(filterMarketRows(null, { category: 'all' }), []);
});

// ---------------------------------------------------------------------------
// normalizeInstallUrl
// ---------------------------------------------------------------------------

test('normalizeInstallUrl: 支持 .zip、.git 与 GitHub 仓库页 URL，拒绝非 https 或非法格式', () => {
  assert.deepEqual(normalizeInstallUrl(''), { error: '请输入安装 URL' });
  assert.deepEqual(normalizeInstallUrl('   '), { error: '请输入安装 URL' });
  assert.deepEqual(normalizeInstallUrl('http://example.com/a.zip'), {
    error: '仅支持 https:// 链接'
  });
  assert.deepEqual(normalizeInstallUrl('https://cdn.example.com/plugin.zip?token=123'), {
    source: 'zip:https://cdn.example.com/plugin.zip?token=123'
  });
  assert.deepEqual(normalizeInstallUrl('https://github.com/user/repo.git'), {
    source: 'git:https://github.com/user/repo.git'
  });
  assert.deepEqual(normalizeInstallUrl('https://github.com/user/repo'), {
    source: 'git:https://github.com/user/repo.git'
  });
  assert.deepEqual(normalizeInstallUrl('https://github.com/user/repo/'), {
    source: 'git:https://github.com/user/repo.git'
  });
  assert.deepEqual(normalizeInstallUrl('https://example.com/not-a-plugin'), {
    error: '仅支持 .git 仓库、.zip 直链或 GitHub 仓库页 URL'
  });
});
