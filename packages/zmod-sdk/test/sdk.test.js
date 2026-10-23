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
});
