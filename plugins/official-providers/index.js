import { definePlugin } from '@zmod/sdk';

/**
 * Data source providers for the ZMod datasource registry.
 *
 * Everything is configuration-driven: this plugin ships zero endpoints and
 * zero credentials. Users create instances in 设置 → ZMod → 数据源.
 *
 * All presets share one generic JSON engine: send an HTTP request, extract
 * values via dot-paths from the JSON response. `custom-http` exposes the
 * engine directly; the branded presets merely pre-fill sensible defaults.
 */

function dot(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Shared fetchStatus for the generic JSON engine.
 * settings: url, method, headersJson, body, token(secret), pathsJson
 * pathsJson: { "余额": "data.balance", "今日用量": "data.usage.today" }
 */
async function jsonEngineStatus(settings, ctx) {
  if (!settings.url) return { ok: false, message: '未配置请求地址（url）' };
  let headers = {};
  if (settings.headersJson) {
    try {
      headers = JSON.parse(settings.headersJson);
    } catch {
      return { ok: false, message: '请求头 JSON 格式错误' };
    }
  }
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
  const res = await ctx.net.fetch({
    url: settings.url,
    method: settings.method || 'GET',
    headers,
    body: settings.body || undefined
  });
  if (!res.ok && res.status === 0) {
    return { ok: false, message: res.error || '网络请求失败' };
  }
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` };
  }
  if (!res.ok) {
    const apiErr = dot(json, 'message') || dot(json, 'error.message') || dot(json, 'error');
    return { ok: false, message: `HTTP ${res.status}${apiErr ? `：${apiErr}` : ''}` };
  }
  let paths = {};
  if (settings.pathsJson) {
    try {
      paths = JSON.parse(settings.pathsJson);
    } catch {
      return { ok: false, message: '提取路径 JSON 格式错误（应为 {"显示名": "a.b.c"}）' };
    }
  }
  const rows = [];
  for (const [label, p] of Object.entries(paths)) {
    const v = dot(json, p);
    if (v !== undefined && v !== null) rows.push({ label, value: String(v) });
  }
  if (rows.length === 0) {
    rows.push({ label: '响应', value: summarize(json) });
  }
  return { ok: true, rows };
}

function summarize(json) {
  const s = JSON.stringify(json);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

const COMMON_ENGINE_SETTINGS = {
  url: {
    type: 'text',
    title: '请求地址',
    description: '完整 http(s) 接口地址，GET 请求直接返回 JSON 的接口最简单',
    placeholder: 'https://example.com/api/balance'
  },
  method: {
    type: 'select',
    title: '请求方法',
    default: 'GET',
    options: [
      { value: 'GET', label: 'GET' },
      { value: 'POST', label: 'POST' }
    ]
  },
  token: {
    type: 'secret',
    title: '访问令牌（可选）',
    description: '将以 Authorization: Bearer <令牌> 头发送，加密保存'
  },
  headersJson: {
    type: 'text',
    title: '附加请求头（可选）',
    description: 'JSON 对象格式，如 {"X-Api-Key": "..."}',
    placeholder: '{}'
  },
  body: {
    type: 'text',
    title: '请求体（可选）',
    description: 'POST 时的请求体内容'
  },
  pathsJson: {
    type: 'text',
    title: '结果提取路径',
    description: 'JSON 对象：显示名 → 响应中的取值路径。如 {"余额": "data.balance"}',
    placeholder: '{"余额": "data.balance"}'
  }
};

function preset(overrides) {
  const custom = overrides.settings || {};
  return {
    ...overrides,
    settings: Object.fromEntries(
      Object.entries({ ...COMMON_ENGINE_SETTINGS, ...custom }).map(([key, def]) => [
        key,
        key in COMMON_ENGINE_SETTINGS ? { ...COMMON_ENGINE_SETTINGS[key], ...def } : def
      ])
    ),
    fetchStatus: jsonEngineStatus,
    test: jsonEngineStatus
  };
}

export default definePlugin({
  id: 'official-providers',
  name: '数据源适配器（官方）',
  version: '1.0.0',
  description: '提供通用 HTTP 与常用平台预设的数据源类型；凭据全部加密保存，出厂零预配',
  author: 'ZMod Team',

  start(ctx) {
    const ds = ctx.datasources;
    if (!ds) {
      console.warn('[official-providers] this kernel has no datasource registry');
      return;
    }
    ds.registerProvider(
      preset({
        type: 'custom-http',
        label: '自定义 HTTP 接口',
        description: '任意返回 JSON 的接口：填地址、鉴权与取值路径即可接入'
      })
    );
    ds.registerProvider(
      preset({
        type: 'openai-compatible',
        label: 'OpenAI 兼容网关',
        description: '兼容 /v1/dashboard 或 /v1/usage 类查询接口的反代网关；地址与令牌自行填写',
        settings: {
          method: { default: 'GET' },
          pathsJson: {
            placeholder: '{"总额度": "total_available", "已用": "total_usage"}',
            description: '按你网关的响应字段填写取值路径'
          }
        }
      })
    );
    ds.registerProvider(
      preset({
        type: 'console-web',
        label: '控制台网页接口（Cookie）',
        description: '需要登录态 Cookie 的控制台余额接口；Cookie 加密保存，请自行确认接口地址与合规性',
        settings: {
          headersJson: {
            title: '附加请求头（含 Cookie）',
            description: '如 {"Cookie": "..."}；敏感值建议改用下方令牌字段',
            placeholder: '{"Cookie": "..."}'
          }
        }
      })
    );
    console.log('[official-providers] registered 3 data source providers');
  }
});
