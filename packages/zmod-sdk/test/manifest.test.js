import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateManifestSchema,
  checkEngine,
  parseVersion,
  compareVersions
} from '../src/manifest.js';

function baseManifest(overrides = {}) {
  return {
    id: 'test-plugin',
    name: '测试插件',
    version: '1.0.0',
    description: '测试用',
    author: 'ZMod Team',
    ...overrides
  };
}

test('validateManifestSchema: 合法 manifest 通过且无告警', () => {
  const r = validateManifestSchema(baseManifest({
    entry: 'main.js',
    engine: { zmod: '>=1.0.0', zcode: '*' },
    permissions: ['dom.patch', 'net.fetch', 'vault.write', 'vault.read', 'datasource'],
    category: 'productivity',
    homepage: 'https://example.com',
    repo: 'https://github.com/OkmiHonor/ZMod-for-ZCode'
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('validateManifestSchema: id 规则', () => {
  for (const bad of ['Bad_ID', '-lead', 'has space', '大写', '', 'a_b']) {
    const r = validateManifestSchema(baseManifest({ id: bad }));
    assert.equal(r.ok, false, `id "${bad}" 应被拒绝`);
    assert.ok(r.errors.some((e) => e.includes('"id"')), `id "${bad}" 的报错应指向 id 字段`);
  }
  assert.equal(validateManifestSchema(baseManifest({ id: 'a' })).ok, true);
  assert.equal(validateManifestSchema(baseManifest({ id: '0abc-9' })).ok, true);
});

test('validateManifestSchema: 必填字段缺失报错', () => {
  for (const field of ['name', 'version', 'description', 'author']) {
    const m = baseManifest();
    delete m[field];
    const r = validateManifestSchema(m);
    assert.equal(r.ok, false, `缺少 ${field} 应失败`);
    assert.ok(r.errors.some((e) => e.includes(`"${field}"`)));
  }
});

test('validateManifestSchema: permissions 白名单', () => {
  const r = validateManifestSchema(baseManifest({ permissions: ['dom.patch', 'fs.rawwrite'] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('fs.rawwrite') && e.includes('dom.patch')));
  // 大小写敏感、非字符串元素、非数组均报错
  assert.equal(validateManifestSchema(baseManifest({ permissions: ['DOM.PATCH'] })).ok, false);
  assert.equal(validateManifestSchema(baseManifest({ permissions: [123] })).ok, false);
  assert.equal(validateManifestSchema(baseManifest({ permissions: 'dom.patch' })).ok, false);
});

test('validateManifestSchema: category 枚举 / repo 宽松校验 / 未知字段告警', () => {
  assert.equal(validateManifestSchema(baseManifest({ category: 'tooling' })).ok, false);
  assert.equal(validateManifestSchema(baseManifest({ category: 'fun' })).ok, true);
  assert.equal(validateManifestSchema(baseManifest({ repo: 'not-a-url' })).ok, false);
  assert.equal(validateManifestSchema(baseManifest({ repo: 'ftp://x' })).ok, false);

  const r = validateManifestSchema(baseManifest({ legacyField: true }));
  assert.equal(r.ok, true); // 未知字段只警告不报错
  assert.ok(r.warnings.some((w) => w.includes('legacyField')));
});

test('validateManifestSchema: engine 范围语法非法报错', () => {
  assert.equal(validateManifestSchema(baseManifest({ engine: { zmod: '>=1.x' } })).ok, false);
  assert.equal(validateManifestSchema(baseManifest({ engine: { zmod: 'latest' } })).ok, false);
  assert.equal(validateManifestSchema(baseManifest({ engine: { npm: '>=1.0.0' } })).ok, false);
  assert.equal(validateManifestSchema(baseManifest({ engine: '>=1.0.0' })).ok, false);
});

test('semver 解析与比较', () => {
  assert.ok(parseVersion('1.0.0'));
  assert.ok(parseVersion('1.0.0-beta.11'));
  assert.equal(parseVersion('1.0'), null);
  assert.equal(parseVersion('v1.0.0'), null);
  assert.equal(parseVersion('abc'), null);

  assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.11') < 0); // 数字标识符按数值比
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta.1') < 0);
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0-beta.1.1') < 0); // 前缀短者小
  assert.ok(compareVersions('1.0.0+build', '1.0.0') === 0); // build metadata 忽略
});

test('checkEngine: >= 含等号，"1.0.0-beta" 满足 ">=1.0.0-beta"', () => {
  const r = checkEngine(
    { engine: { zmod: '>=1.0.0-beta' } },
    { zmodVersion: '1.0.0-beta' }
  );
  assert.deepEqual(r, { ok: true, reasons: [] });
});

test('checkEngine: ">=1.0.0" 拒绝 0.9.0', () => {
  const r = checkEngine({ engine: { zmod: '>=1.0.0' } }, { zmodVersion: '0.9.0' });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.length === 1);
  assert.ok(r.reasons[0].includes('>=1.0.0'));
  assert.ok(r.reasons[0].includes('0.9.0'));
});

test('checkEngine: ^1.0.0 拒绝 1.0.0-beta、接受 1.0.0', () => {
  assert.equal(
    checkEngine({ engine: { zmod: '^1.0.0' } }, { zmodVersion: '1.0.0-beta' }).ok,
    false
  );
  assert.deepEqual(
    checkEngine({ engine: { zmod: '^1.0.0' } }, { zmodVersion: '1.0.0' }),
    { ok: true, reasons: [] }
  );
  // ^1.0.0 上界 <2.0.0
  assert.equal(
    checkEngine({ engine: { zmod: '^1.0.0' } }, { zmodVersion: '2.0.0' }).ok,
    false
  );
});

test('checkEngine: ~1.2.3 接受 1.2.9、拒绝 1.3.0', () => {
  assert.deepEqual(
    checkEngine({ engine: { zmod: '~1.2.3' } }, { zmodVersion: '1.2.9' }),
    { ok: true, reasons: [] }
  );
  assert.equal(
    checkEngine({ engine: { zmod: '~1.2.3' } }, { zmodVersion: '1.3.0' }).ok,
    false
  );
  assert.equal(
    checkEngine({ engine: { zmod: '~1.2.3' } }, { zmodVersion: '1.2.2' }).ok,
    false
  );
});

test('checkEngine: * 与缺 engine 均不限', () => {
  assert.deepEqual(
    checkEngine({ engine: { zmod: '*', zcode: '*' } }, { zmodVersion: '9.9.9-alpha', hostVersion: '0.0.1' }),
    { ok: true, reasons: [] }
  );
  assert.deepEqual(checkEngine({}, { zmodVersion: '0.1.0' }), { ok: true, reasons: [] });
  assert.deepEqual(checkEngine({ engine: {} }, {}), { ok: true, reasons: [] });
  assert.deepEqual(
    checkEngine({ engine: { zmod: '', zcode: null } }, {}),
    { ok: true, reasons: [] }
  );
});

test('checkEngine: 精确版本与 zcode 引擎', () => {
  assert.deepEqual(
    checkEngine({ engine: { zcode: '3.2.1' } }, { hostVersion: '3.2.1' }),
    { ok: true, reasons: [] }
  );
  const r = checkEngine({ engine: { zcode: '3.2.1' } }, { hostVersion: '3.3.0' });
  assert.equal(r.ok, false);
  assert.ok(r.reasons[0].includes('ZCode'));
  assert.ok(r.reasons[0].includes('3.3.0'));
});

test('checkEngine: prerelease 标识符逐段比较', () => {
  // 1.0.0-beta.11 >= 1.0.0-beta.2（数字按数值比较，11 > 2）
  assert.equal(
    checkEngine({ engine: { zmod: '>=1.0.0-beta.2' } }, { zmodVersion: '1.0.0-beta.11' }).ok,
    true
  );
  // 1.0.0-beta.11 < 1.0.0-rc.1（字母逐段比较 beta < rc）
  assert.equal(
    checkEngine({ engine: { zmod: '>=1.0.0-rc.1' } }, { zmodVersion: '1.0.0-beta.11' }).ok,
    false
  );
});

test('checkEngine: 无法确定当前版本时按不满足处理并说明', () => {
  const r = checkEngine({ engine: { zmod: '>=1.0.0' } }, {});
  assert.equal(r.ok, false);
  assert.ok(r.reasons[0].includes('无法确定当前版本'));
});
