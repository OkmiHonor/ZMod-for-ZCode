/**
 * Supported Setting Schema Types:
 * - 'switch': boolean
 * - 'text': string
 * - 'secret': sensitive string (vault backed)
 * - 'number': number
 * - 'slider': number with range
 * - 'select': enum / dropdown
 * - 'color': hex color string
 * - 'group': visual section heading (no value; "title" is the heading text)
 * - 'action': trigger button bound to a plugin action (no persisted value)
 */

export const SETTING_TYPES = new Set([
  'switch',
  'text',
  'secret',
  'number',
  'slider',
  'select',
  'color',
  'group',
  'action'
]);

/** Types that persist a value in config/vault. Group/action are layout-only. */
export const VALUELESS_SETTING_TYPES = new Set(['group', 'action']);

export function validateSettingSchema(key, schema) {
  if (!schema || typeof schema !== 'object') {
    throw new Error(`Setting "${key}" must be an object definition`);
  }
  if (!SETTING_TYPES.has(schema.type)) {
    throw new Error(`Setting "${key}" has invalid type "${schema.type}". Supported: ${[...SETTING_TYPES].join(', ')}`);
  }
  if (typeof schema.title !== 'string') {
    throw new Error(`Setting "${key}" requires a string "title"`);
  }
  if (schema.type === 'select') {
    if (!Array.isArray(schema.options) || schema.options.length === 0) {
      throw new Error(`Select setting "${key}" must provide a non-empty "options" array`);
    }
  }
  if (schema.type === 'slider') {
    if (typeof schema.min !== 'number' || typeof schema.max !== 'number') {
      throw new Error(`Slider setting "${key}" must specify "min" and "max" numbers`);
    }
  }
  if (schema.type === 'action') {
    if (typeof schema.action !== 'string' || !schema.action) {
      throw new Error(`Action setting "${key}" must reference a plugin action key via "action"`);
    }
  }
  return true;
}

export function validateSettings(settings) {
  if (!settings) return {};
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Plugin "settings" must be an object map of key => definition');
  }
  for (const [key, schema] of Object.entries(settings)) {
    validateSettingSchema(key, schema);
  }
  return settings;
}
