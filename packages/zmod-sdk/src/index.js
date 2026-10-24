import { validateSettings } from './schema.js';

export * from './schema.js';

/**
 * Standard Plugin Definition Specification
 *
 * @param {Object} def
 * @param {string} def.id - Unique kebab-case ID (e.g. 'qcard-fade')
 * @param {string} def.name - Display name (e.g. '提问卡智能淡出')
 * @param {string} def.description - Description of what the plugin does
 * @param {string} def.version - Semver version string
 * @param {string} def.author - Author name
 * @param {Object} [def.settings] - Declarative settings schema
 * @param {Function} [def.start] - Start lifecycle hook, receives the plugin ctx
 * @param {Function} [def.stop] - Stop lifecycle hook
 * @param {string} [def.styles] - Optional raw CSS string to inject
 *
 * The returned object is intentionally NOT frozen: plugins may attach their own
 * lifecycle state (e.g. `this._cleanup = ...` inside start()). Use ctx.cleanup(fn)
 * for teardown instead whenever possible — it runs LIFO on disable.
 */
export function definePlugin(def) {
  if (!def || typeof def !== 'object') {
    throw new Error('definePlugin requires a plugin definition object');
  }
  if (!def.id || typeof def.id !== 'string') {
    throw new Error('Plugin definition missing required string "id"');
  }
  if (!/^[a-z0-9-]+$/.test(def.id)) {
    throw new Error(`Plugin id "${def.id}" must be kebab-case (lowercase alphanumeric and hyphens)`);
  }
  if (!def.name || typeof def.name !== 'string') {
    throw new Error(`Plugin "${def.id}" missing required string "name"`);
  }
  if (!def.version || typeof def.version !== 'string') {
    throw new Error(`Plugin "${def.id}" missing required string "version"`);
  }

  const validatedSettings = validateSettings(def.settings);

  return {
    id: def.id,
    name: def.name,
    description: def.description || '',
    version: def.version,
    author: def.author || 'Anonymous',
    settings: validatedSettings,
    styles: typeof def.styles === 'string' ? def.styles : '',
    start: typeof def.start === 'function' ? def.start : null,
    stop: typeof def.stop === 'function' ? def.stop : null
  };
}
