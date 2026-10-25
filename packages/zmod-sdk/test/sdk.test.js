import test from 'node:test';
import assert from 'node:assert/strict';
import { definePlugin, validateSettings } from '../src/index.js';

test('ZMod SDK definePlugin & Schema Suite', async (t) => {
  await t.test('valid plugin definition', () => {
    const plugin = definePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      description: 'A test plugin',
      version: '1.0.0',
      author: 'Tester',
      settings: {
        enabledFeature: {
          type: 'switch',
          title: 'Enable Feature',
          default: true
        },
        threshold: {
          type: 'slider',
          title: 'Threshold',
          default: 50,
          min: 0,
          max: 100
        },
        mode: {
          type: 'select',
          title: 'Mode',
          options: [
            { label: 'Fast', value: 'fast' },
            { label: 'Safe', value: 'safe' }
          ],
          default: 'fast'
        }
      },
      start({ settings }) {
        // no-op
      }
    });

    assert.equal(plugin.id, 'test-plugin');
    assert.equal(plugin.name, 'Test Plugin');
    assert.ok(plugin.settings.enabledFeature);
    assert.equal(plugin.settings.threshold.max, 100);
  });

  await t.test('invalid plugin id throws', () => {
    assert.throws(() => {
      definePlugin({
        id: 'Invalid_ID!',
        name: 'Bad',
        version: '1.0.0'
      });
    }, /must be kebab-case/);
  });

  await t.test('invalid setting type throws', () => {
    assert.throws(() => {
      definePlugin({
        id: 'bad-setting',
        name: 'Bad Setting',
        version: '1.0.0',
        settings: {
          foo: {
            type: 'unsupported-type',
            title: 'Foo'
          }
        }
      });
    }, /has invalid type/);
  });

  await t.test('definitions are extensible — start() may attach lifecycle state', () => {
    // regression: an early alpha froze the definition object, and plugins that
    // wrote `this._cleanup = ...` inside start() crashed with a TypeError
    const plugin = definePlugin({
      id: 'lifecycle-state',
      name: 'Lifecycle State',
      version: '1.0.0',
      start() {
        this._cleanup = () => {};
      }
    });
    assert.doesNotThrow(() => plugin.start({}));
    assert.equal(typeof plugin._cleanup, 'function');
    assert.equal(Object.isFrozen(plugin), false);
  });

  await t.test('group and action setting types are accepted', () => {
    const plugin = definePlugin({
      id: 'layout-types',
      name: 'Layout Types',
      version: '1.0.0',
      settings: {
        sectionA: { type: 'group', title: '分组标题' },
        apiKey: { type: 'secret', title: 'API Key' },
        probe: { type: 'action', title: '测试连接', action: 'testConnection' }
      },
      actions: {
        testConnection: {
          title: '测试连接',
          async run() {
            return { ok: true, message: 'ok' };
          }
        }
      }
    });
    assert.equal(plugin.settings.sectionA.type, 'group');
    assert.equal(plugin.settings.probe.action, 'testConnection');
    assert.equal(typeof plugin.actions.testConnection.run, 'function');
  });

  await t.test('action setting without action key throws', () => {
    assert.throws(() => {
      definePlugin({
        id: 'bad-action',
        name: 'Bad Action',
        version: '1.0.0',
        settings: {
          probe: { type: 'action', title: '测试' }
        }
      });
    }, /must reference a plugin action key/);
  });

  await t.test('malformed actions map throws', () => {
    assert.throws(() => {
      definePlugin({
        id: 'bad-actions-map',
        name: 'Bad Actions',
        version: '1.0.0',
        actions: { broken: { title: '无 run' } }
      });
    }, /requires a "run" function/);
  });

  await t.test('renderSettings function passes through to the definition', () => {
    const fn = () => {};
    const plugin = definePlugin({
      id: 'custom-settings',
      name: 'Custom Settings',
      version: '1.0.0',
      renderSettings: fn
    });
    assert.equal(plugin.renderSettings, fn);
  });

  await t.test('absent renderSettings normalizes to null', () => {
    const plugin = definePlugin({
      id: 'no-custom-settings',
      name: 'No Custom Settings',
      version: '1.0.0'
    });
    assert.equal(plugin.renderSettings, null);
  });

  await t.test('non-function renderSettings throws', () => {
    assert.throws(() => {
      definePlugin({
        id: 'bad-render-settings',
        name: 'Bad Render Settings',
        version: '1.0.0',
        renderSettings: 'not-a-function'
      });
    }, /"renderSettings" must be a function/);
  });
});
