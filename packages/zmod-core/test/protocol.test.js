import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

const tempDir = path.join(os.tmpdir(), `zmod-protocol-test-${Date.now()}`);
process.env.ZMOD_USER_DATA_DIR = tempDir;

const { resolveHostFile, rewriteSdkSpecifiers, SCHEME } = await import('../src/main/protocol.js');

test('protocol security & routing suite', async (t) => {
  await t.test('core host maps into runtime/core', () => {
    const r = resolveHostFile(`${SCHEME}://core/index.js`);
    assert.equal(r.host, 'core');
    assert.equal(r.file, path.join(tempDir, 'runtime', 'core', 'index.js'));
  });

  await t.test('plugins host maps into the plugin directory', () => {
    const r = resolveHostFile(`${SCHEME}://plugins/qcard-fade/sub/style.css`);
    assert.equal(r.host, 'plugins');
    assert.equal(r.file, path.join(tempDir, 'plugins', 'qcard-fade', 'sub', 'style.css'));
  });

  await t.test('path traversal is rejected', () => {
    assert.equal(resolveHostFile(`${SCHEME}://core/../../../etc/passwd`), null);
    assert.equal(resolveHostFile(`${SCHEME}://plugins/x/..%2F..%2Fsecret.js`), null);
    // encoded backslash escape attempt (win32)
    assert.equal(resolveHostFile(`${SCHEME}://core/%2e%2e%5c%2e%2e%5czmod.vault`), null);
  });

  await t.test('invalid plugin ids and unknown hosts are rejected', () => {
    assert.equal(resolveHostFile(`${SCHEME}://plugins/../evil.js`), null);
    assert.equal(resolveHostFile(`${SCHEME}://unknown-host/index.js`), null);
    assert.equal(resolveHostFile('file:///C:/Windows/system32'), null);
    assert.equal(resolveHostFile(''), null);
  });

  await t.test('sdk bare-specifier rewrite covers subpaths and quote styles', () => {
    const code = [
      `import { definePlugin } from '@zmod/sdk';`,
      `import { validateSettings } from "@zmod/sdk/schema";`,
      `const note = 'not @zmod/sdk in plain string position';`
    ].join('\n');
    const out = rewriteSdkSpecifiers(code);
    assert.ok(out.includes(`from '${SCHEME}://sdk/index.js'`), out);
    assert.ok(out.includes(`from "${SCHEME}://sdk/schema.js"`), out);
    // plain strings are rewritten too — acceptable: the specifier is reserved
    assert.ok(!out.includes("'@zmod/sdk'"));
  });
});
