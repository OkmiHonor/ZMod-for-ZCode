import test from 'node:test';
import assert from 'node:assert/strict';

// settings-page.js 模块顶层无 DOM 依赖（只有常量与函数声明），可在 Node 单测中导入。
// 这里只测拖放安装的纯函数：collectFilesFromEntry / arrayBufferToBase64。
const { collectFilesFromEntry, arrayBufferToBase64, DROP_SKIP_DIR_NAMES, DROP_MAX_TOTAL_BYTES } =
  await import('../src/renderer/settings-page.js');

// ---- fake entry tree（webKitGetAsEntry 协议的离线 mock）----

function fakeFile(name, content) {
  const bytes = new TextEncoder().encode(content);
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok) => ok({ name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  };
}

/** readEntries 每批至多 2 条（刻意分批，验证空批终止 + 多批合并）。 */
function fakeDir(name, children) {
  let cursor = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (ok) => {
        const batch = children.slice(cursor, cursor + 2);
        cursor += batch.length;
        ok(batch);
      }
    })
  };
}

// ---- arrayBufferToBase64 ----

test('arrayBufferToBase64: 往返一致，且支持跨 32KB 块的大缓冲', () => {
  const small = new TextEncoder().encode('hello 拖放');
  assert.equal(Buffer.from(arrayBufferToBase64(small), 'base64').toString('utf8'), 'hello 拖放');

  const big = new Uint8Array(100 * 1024); // 跨多个 0x8000 块
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const decoded = Buffer.from(arrayBufferToBase64(big), 'base64');
  assert.equal(decoded.length, big.length);
  assert.deepEqual([...decoded.subarray(0, 8)], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(decoded[big.length - 1], (big.length - 1) & 0xff);
});

// ---- collectFilesFromEntry ----

test('collectFilesFromEntry: 递归收集文件，path 为相对路径且保留子目录层级', async () => {
  const tree = fakeDir('my-plugin', [
    fakeFile('manifest.json', '{}'),
    fakeFile('index.js', 'export default {};\n'),
    fakeDir('lib', [
      fakeFile('util.js', 'export const x = 1;\n'),
      fakeDir('deep', [fakeFile('a.txt', 'a')])
    ])
  ]);

  const files = await collectFilesFromEntry(tree);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['index.js', 'lib/deep/a.txt', 'lib/util.js', 'manifest.json']);
  const manifest = files.find((f) => f.path === 'manifest.json');
  assert.equal(Buffer.from(manifest.b64, 'base64').toString('utf8'), '{}');
});

test('collectFilesFromEntry: 跳过 node_modules 与 .git（含深层出现）', async () => {
  const tree = fakeDir('skip-plugin', [
    fakeFile('manifest.json', '{}'),
    fakeDir('node_modules', [fakeFile('dep.js', 'noise')]),
    fakeDir('lib', [
      fakeDir('.git', [fakeFile('HEAD', 'ref:')]),
      fakeFile('keep.js', 'keep')
    ])
  ]);

  const files = await collectFilesFromEntry(tree);
  assert.deepEqual(files.map((f) => f.path).sort(), ['lib/keep.js', 'manifest.json']);
});

test('collectFilesFromEntry: 根级文件调用（拖单个文件 entry）path 直接用其名字', async () => {
  const files = await collectFilesFromEntry(fakeFile('manifest.json', '{"id":"x"}'));
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'manifest.json');
});

test('collectFilesFromEntry: 总量超 maxBytes 抛 DROP_TOO_LARGE', async () => {
  const tree = fakeDir('big', [
    fakeFile('a.bin', 'x'.repeat(1024)),
    fakeFile('b.bin', 'y'.repeat(1024))
  ]);
  await assert.rejects(
    collectFilesFromEntry(tree, { maxBytes: 1024 }),
    (err) => err.code === 'DROP_TOO_LARGE'
  );
});

test('collectFilesFromEntry: 单个条目读取失败走 onError 旁路，不阻断其余收集', async () => {
  const bad = {
    isFile: true,
    isDirectory: false,
    name: 'broken.js',
    file: (_ok, errCb) => errCb(new Error('entry gone'))
  };
  const errors = [];
  const files = await collectFilesFromEntry(
    fakeDir('partial', [bad, fakeFile('ok.txt', 'ok')]),
    { onError: (err) => errors.push(err) }
  );
  assert.deepEqual(files.map((f) => f.path), ['ok.txt']);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.message || errors[0]), /entry gone/);
});

test('常量: 跳过名单与 20MB 上限符合拖放管线约定', () => {
  assert.deepEqual([...DROP_SKIP_DIR_NAMES].sort(), ['.git', 'node_modules']);
  assert.equal(DROP_MAX_TOTAL_BYTES, 20 * 1024 * 1024);
});
