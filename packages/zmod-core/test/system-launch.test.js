import test from 'node:test';
import assert from 'node:assert/strict';
import { rpcGateway } from '../src/main/rpc.js';

test('system.launchApp: rejects empty or non-string execPath', async () => {
  const r1 = await rpcGateway.dispatch('system.launchApp', {});
  assert.equal(r1.ok, false);
  assert.match(r1.error, /Invalid execPath/);

  const r2 = await rpcGateway.dispatch('system.launchApp', { execPath: '   ' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Invalid execPath/);
});

test('system.launchApp: returns error when executable does not exist', async () => {
  const r = await rpcGateway.dispatch('system.launchApp', {
    execPath: 'C:\\path\\does\\not\\exist\\app.exe'
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Executable not found/);
});

test('system.launchApp: successfully launches valid process and returns pid', async () => {
  // Use current node binary as a safe executable
  const nodePath = process.execPath;
  const res = await rpcGateway.dispatch('system.launchApp', {
    execPath: nodePath,
    args: ['-e', 'process.exit(0)']
  });
  assert.equal(res.ok, true);
  assert.ok(typeof res.pid === 'number' && res.pid > 0);
});
