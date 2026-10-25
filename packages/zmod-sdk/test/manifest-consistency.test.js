import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifestSchema } from '../src/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.join(__dirname, '..', '..', '..', 'plugins');

const pluginDirs = fs
  .readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(PLUGINS_DIR, d.name, 'manifest.json')))
  .map((d) => d.name);

test(`发现插件目录（预期 4 个）: ${pluginDirs.join(', ')}`, () => {
  assert.ok(pluginDirs.length >= 1, `至少应有 1 个插件目录，实际发现 ${pluginDirs.length}`);
});

/**
 * 提取策略：四个插件的 index.js 均以 `definePlugin({` 开头声明定义对象，
 * 且顶层第一个键就是 id、随后是 version。嵌套对象（settings/actions 等）
 * 内部也可能出现 id:/version:，因此只取 definePlugin( 之后最靠前的首个
 * `id:` / `version:` 字面量，即为顶层值。
 */
function extractDefinePluginFields(source) {
  const marker = 'definePlugin(';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'index.js 必须包含 definePlugin( 调用');
  const slice = source.slice(start);
  const idMatch = slice.match(/\bid\s*:\s*(['"])((?:(?!\1).)*)\1/);
  const versionMatch = slice.match(/\bversion\s*:\s*(['"])((?:(?!\1).)*)\1/);
  return {
    id: idMatch ? idMatch[2] : null,
    version: versionMatch ? versionMatch[2] : null
  };
}

for (const name of pluginDirs) {
  test(`插件 ${name}: manifest v2 校验通过且与 index.js definePlugin 一致`, () => {
    const dir = path.join(PLUGINS_DIR, name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

    const schema = validateManifestSchema(manifest);
    assert.deepEqual(
      { ok: schema.ok, errors: schema.errors },
      { ok: true, errors: [] },
      `${name}/manifest.json 未通过 v2 校验`
    );
    assert.deepEqual(schema.warnings, [], `${name}/manifest.json 不应含未知字段`);

    const source = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
    const fields = extractDefinePluginFields(source);
    assert.equal(fields.id, manifest.id, `${name}: definePlugin.id 与 manifest.id 不一致`);
    assert.equal(fields.version, manifest.version, `${name}: definePlugin.version 与 manifest.version 不一致`);

    // manifest 声明的 entry（缺省 index.js）必须真实存在
    const entryFile = manifest.entry || 'index.js';
    assert.ok(fs.existsSync(path.join(dir, entryFile)), `${name}: entry "${entryFile}" 不存在`);
  });
}
