/**
 * Manifest v2 schema validation and engine compatibility checks.
 *
 * v2 is backward compatible: every new field is optional. No npm semver
 * dependency — a minimal subset (exact / >= / ^ / ~ / *) is implemented here.
 */

const REQUIRED_STRING_FIELDS = ['name', 'version', 'description', 'author'];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const KNOWN_PERMISSIONS = new Set([
  'dom.patch',
  'net.fetch',
  'vault.write',
  'vault.read',
  'datasource'
]);

const KNOWN_CATEGORIES = new Set(['appearance', 'productivity', 'datasource', 'fun']);

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'id',
  'name',
  'version',
  'description',
  'author',
  'entry',
  'engine',
  'permissions',
  'category',
  'homepage',
  'repo'
]);

/** strict semver: major.minor.patch[-prerelease][+build] */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** range subset: '*' | 'x.y.z' | '>=x.y.z' | '^x.y.z' | '~x.y.z' (prerelease allowed in the base version) */
const RANGE_PATTERN = /^(>=|\^|~)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

/**
 * Parse a strict semver string. Returns
 * { major, minor, patch, prerelease: string[] } or null when unparseable.
 */
export function parseVersion(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(VERSION_PATTERN);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : []
  };
}

function isNumericIdentifier(s) {
  return /^\d+$/.test(s);
}

/**
 * Semver precedence comparison. Negative / 0 / positive like strcmp.
 * Prerelease per spec: no-prerelease > with-prerelease; identifiers compared
 * pairwise (numeric numerically, numeric < alphanumeric, shorter prefix loses).
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) {
    throw new Error(`compareVersions requires valid semver strings, got "${a}" vs "${b}"`);
  }
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  if (va.patch !== vb.patch) return va.patch - vb.patch;

  const pa = va.prerelease;
  const pb = vb.prerelease;
  if (pa.length === 0 && pb.length === 0) return 0;
  // release (no prerelease) outranks any prerelease of the same x.y.z
  if (pa.length === 0) return 1;
  if (pb.length === 0) return -1;

  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ia = pa[i];
    const ib = pb[i];
    if (ia === undefined) return -1; // shorter prefix loses
    if (ib === undefined) return 1;
    const na = isNumericIdentifier(ia);
    const nb = isNumericIdentifier(ib);
    if (na && nb) {
      const d = Number(ia) - Number(ib);
      if (d !== 0) return d;
    } else if (na !== nb) {
      return na ? -1 : 1; // numeric < alphanumeric
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Parse the supported range subset. Returns
 * { op: '*' } | { op: '>=' | '^' | '~' | '=', version } or null when invalid.
 */
export function parseRange(range) {
  const s = String(range ?? '').trim();
  if (s === '' || s === '*') return { op: '*' };
  const m = s.match(RANGE_PATTERN);
  if (!m) return null;
  return { op: m[1] || '=', version: `${m[2]}.${m[3]}.${m[4]}${m[5] ? `-${m[5]}` : ''}` };
}

function satisfiesCaret(versionStr, baseStr) {
  const base = parseVersion(baseStr);
  const v = parseVersion(versionStr);
  const cmp = compareVersions(versionStr, baseStr);
  if (cmp < 0) return false;
  if (base.major > 0) return v.major === base.major;
  if (base.minor > 0) return v.major === 0 && v.minor === base.minor;
  return v.major === 0 && v.minor === 0 && v.patch === base.patch;
}

/**
 * Check a version string against a range string from the supported subset.
 * Returns null when either side is unparseable (caller decides how to report).
 */
export function satisfiesRange(versionStr, rangeStr) {
  const range = parseRange(rangeStr);
  if (!range) return null;
  const v = parseVersion(versionStr);
  if (!v) return null;
  switch (range.op) {
    case '*':
      return true;
    case '=':
      return compareVersions(versionStr, range.version) === 0;
    case '>=':
      // >= includes equality, so ">=1.0.0-beta" accepts "1.0.0-beta"
      return compareVersions(versionStr, range.version) >= 0;
    case '^':
      return satisfiesCaret(versionStr, range.version);
    case '~':
      // ~1.2.3 := >=1.2.3 <1.3.0
      return (
        compareVersions(versionStr, range.version) >= 0 &&
        (v.major === parseVersion(range.version).major) &&
        (v.minor === parseVersion(range.version).minor)
      );
    default:
      return null;
  }
}

const ENGINE_TARGETS = [
  { key: 'zmod', label: 'ZMod', envKey: 'zmodVersion' },
  { key: 'zcode', label: 'ZCode', envKey: 'hostVersion' }
];

/**
 * Engine compatibility check against manifest.engine.
 * Missing engine or empty fields mean "no constraint". All range failures are
 * reported as Chinese reasons stating required vs current version.
 *
 * @param {Object} manifest
 * @param {{ zmodVersion?: string, hostVersion?: string }} env
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkEngine(manifest, env = {}) {
  const reasons = [];
  const engine = manifest && manifest.engine;
  if (!engine || typeof engine !== 'object' || Array.isArray(engine)) {
    return { ok: true, reasons };
  }
  for (const { key, label, envKey } of ENGINE_TARGETS) {
    const rangeStr = engine[key];
    if (rangeStr === undefined || rangeStr === null || String(rangeStr).trim() === '') continue;
    const range = parseRange(rangeStr);
    if (!range) {
      reasons.push(`engine.${key} 不是受支持的版本范围表达式: "${rangeStr}"`);
      continue;
    }
    if (range.op === '*') continue;
    const current = env[envKey];
    const satisfied = satisfiesRange(current, rangeStr);
    if (satisfied === null) {
      reasons.push(`插件需要 ${label} 版本 ${rangeStr}，但无法确定当前版本`);
      continue;
    }
    if (!satisfied) {
      reasons.push(`插件需要 ${label} 版本 ${rangeStr}，当前为 ${current}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function checkUrlish(field, value, errors) {
  if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value.trim())) {
    errors.push(`"${field}" 必须是 http(s) URL 字符串`);
  }
}

/**
 * Validate a manifest.json (v2) object.
 *
 * @param {Object} manifest
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateManifestSchema(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest 必须是 JSON 对象'], warnings };
  }

  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
    errors.push(`"id" 必须匹配 kebab-case（/${ID_PATTERN.source}/），当前为 ${JSON.stringify(manifest.id)}`);
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      errors.push(`"${field}" 是必填的非空字符串`);
    }
  }

  if (manifest.version !== undefined && parseVersion(manifest.version) === null) {
    errors.push(`"version" 必须是合法 semver（x.y.z[-prerelease]），当前为 ${JSON.stringify(manifest.version)}`);
  }

  if (manifest.entry !== undefined) {
    if (typeof manifest.entry !== 'string' || manifest.entry.length === 0) {
      errors.push('"entry" 必须是非空字符串（缺省为 "index.js"）');
    }
  }

  if (manifest.engine !== undefined) {
    const engine = manifest.engine;
    if (!engine || typeof engine !== 'object' || Array.isArray(engine)) {
      errors.push('"engine" 必须是对象（{ zmod?: range, zcode?: range }）');
    } else {
      for (const key of Object.keys(engine)) {
        if (key !== 'zmod' && key !== 'zcode') {
          errors.push(`"engine.${key}" 不是受支持的引擎（仅 zmod / zcode）`);
          continue;
        }
        if (parseRange(engine[key]) === null) {
          errors.push(`"engine.${key}" 不是受支持的版本范围（精确 x.y.z / >=x.y.z / ^x.y.z / ~x.y.z / *），当前为 ${JSON.stringify(engine[key])}`);
        }
      }
    }
  }

  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions) || manifest.permissions.some((p) => typeof p !== 'string')) {
      errors.push('"permissions" 必须是字符串数组');
    } else {
      for (const p of manifest.permissions) {
        if (!KNOWN_PERMISSIONS.has(p)) {
          errors.push(`未知权限 "${p}"（白名单: ${[...KNOWN_PERMISSIONS].join(', ')}）`);
        }
      }
    }
  }

  if (manifest.category !== undefined && !KNOWN_CATEGORIES.has(manifest.category)) {
    errors.push(`"category" 必须是 ${[...KNOWN_CATEGORIES].join(' | ')} 之一，当前为 ${JSON.stringify(manifest.category)}`);
  }

  if (manifest.homepage !== undefined) {
    checkUrlish('homepage', manifest.homepage, errors);
  }
  if (manifest.repo !== undefined) {
    checkUrlish('repo', manifest.repo, errors);
  }

  for (const key of Object.keys(manifest)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`未知字段 "${key}"（v2 规范之外，将被忽略）`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
