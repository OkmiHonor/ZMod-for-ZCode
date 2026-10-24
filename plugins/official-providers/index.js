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

/* Antigravity Tools 网关配额（v1 quota 桥的 antigravity 源等价）：GET
   {网关}/api/accounts/{id}/quota → quota_groups[].buckets[]（window=weekly/5h，
   remaining_fraction 剩余比例）。文件快照回退通道不再保留——渲染层无文件权限，
   网关未启动时直接报错提示。 */
async function antigravityQuotaStatus(settings, ctx) {
  const base = String(settings.url || 'http://127.0.0.1:8045').replace(/\/+$/, '');
  const id = String(settings.accountId || '').trim();
  if (!id) return { ok: false, message: '未配置账号 ID' };
  const res = await ctx.net.fetch({
    url: `${base}/api/accounts/${encodeURIComponent(id)}/quota`,
    method: 'GET',
    headers: settings.token ? { Authorization: `Bearer ${settings.token}` } : {}
  });
  if (!res.ok && res.status === 0) return { ok: false, message: (res.error || '网络请求失败') + '（网关未启动？）' };
  let json = null;
  try { json = JSON.parse(res.text); } catch { return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` }; }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
  const groups = Array.isArray(json.quota_groups) ? json.quota_groups : [];
  if (groups.length === 0) return { ok: false, message: '响应无 quota_groups（账号 ID 是否正确）' };
  const fmtReset = (t) => {
    try {
      const d = new Date(t);
      if (isNaN(d.getTime())) return '';
      return `${d.getMonth() + 1}月${d.getDate()}日`;
    } catch { return ''; }
  };
  const rows = [];
  for (const g of groups) {
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      const frac = Number(b.remaining_fraction);
      if (!isFinite(frac)) continue;
      const win = b.window === 'weekly' ? '每周' : b.window === '5h' ? '5 小时' : b.window || '';
      const reset = fmtReset(b.reset_time);
      rows.push({
        label: `${g.display_name || g.name || '配额'} · ${win}`,
        value: `${(frac * 100).toFixed(1)}% 剩余${reset ? ` · ${reset}重置` : ''}`
      });
    }
  }
  if (rows.length === 0) return { ok: false, message: '配额组里没有可用桶' };
  return {
    ok: true,
    rows: json.subscription_tier
      ? [{ label: '订阅档位', value: String(json.subscription_tier) }, ...rows]
      : rows,
    // structured raw data for model-level matching (quota-popover)
    models: (Array.isArray(json.models) ? json.models : [])
      .filter((m) => m && m.name && isFinite(Number(m.percentage)))
      .map((m) => ({ name: String(m.name).toLowerCase(), percentage: Number(m.percentage), reset: m.reset_time || '' })),
    groups: groups.map((g) => ({
      name: String(g.display_name || g.name || ''),
      buckets: (Array.isArray(g.buckets) ? g.buckets : [])
        .filter((b) => isFinite(Number(b.remaining_fraction)))
        .map((b) => ({ window: b.window, frac: Number(b.remaining_fraction), reset: b.reset_time || '' }))
    }))
  };
}

const COMMON_ENGINE_SETTINGS = {
  url: {
    type: 'text',
    title: '请求地址',
    description: '完整 http(s) 接口地址，GET 请求直接返回 JSON 的接口最简单',
    placeholder: 'https://example.com/api/balance'
  },
  modelKeywords: {
    type: 'text',
    title: '供应商/模型匹配关键字（可选）',
    description: '逗号分隔。当前选中的供应商名或模型名含任一关键字时，用量浮窗显示此源；留空则按实例名称相似度自动匹配',
    placeholder: '百炼, qwen'
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
    // per-preset overrides win; the generic JSON engine is only the fallback
    fetchStatus: overrides.fetchStatus || jsonEngineStatus,
    test: overrides.test || jsonEngineStatus
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
    ds.registerProvider(
      preset({
        type: 'deepseek',
        label: 'DeepSeek 官方余额',
        description: 'DeepSeek 开放平台余额接口：充值/赠送双卡（api.deepseek.com），令牌加密保存',
        settings: {
          url: {
            title: '请求地址',
            default: 'https://api.deepseek.com/user/balance',
            placeholder: 'https://api.deepseek.com/user/balance'
          },
          token: {
            title: 'API Key',
            description: 'DeepSeek 开放平台的 API Key，以 Bearer 头发送，加密保存'
          },
          pathsJson: {
            default: '',
            placeholder: '{"总余额": "balance_infos.0.total_balance", "赠送": "balance_infos.0.granted_balance", "充值": "balance_infos.0.topped_up_balance"}',
            description: '默认留空即可自动使用官方双卡字段；响应含 balance_infos 数组'
          }
        },
        fetchStatus: async (settings, ctx2) => {
          const url = settings.url || 'https://api.deepseek.com/user/balance';
          const res = await ctx2.net.fetch({
            url,
            method: 'GET',
            headers: settings.token ? { Authorization: `Bearer ${settings.token}` } : {}
          });
          if (!res.ok && res.status === 0) return { ok: false, message: res.error || '网络请求失败' };
          let json = null;
          try { json = JSON.parse(res.text); } catch { return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` }; }
          if (!res.ok) {
            return { ok: false, message: `HTTP ${res.status}${json.error?.message ? '：' + json.error.message : ''}` };
          }
          if (!json.is_available || !Array.isArray(json.balance_infos) || !json.balance_infos.length) {
            return { ok: false, message: '账户不可用或无余额信息' };
          }
          const info = json.balance_infos[0];
          const cur = info.currency === 'CNY' ? '¥' : info.currency || '';
          return {
            ok: true,
            balance: String(parseFloat(info.total_balance || 0)),
            currency: cur,
            rows: [
              { label: '充值余额', value: String(parseFloat(info.topped_up_balance || 0)) },
              { label: '赠送余额', value: String(parseFloat(info.granted_balance || 0)) }
            ]
          };
        },
        test: async (settings, ctx2) => {
          const r = await jsonEngineStatus({ ...settings, url: settings.url || 'https://api.deepseek.com/user/balance', method: 'GET' }, ctx2);
          return r.ok ? { ok: true, message: '连接成功，余额接口可访问' } : r;
        }
      })
    );
    ds.registerProvider(
      preset({
        type: 'antigravity',
        label: 'Antigravity 配额（反代网关）',
        description: 'Antigravity Tools 本地网关的账号分组配额（Gemini/Claude/GPT 周额与 5h 额），密钥加密保存',
        settings: {
          url: {
            title: '网关地址',
            default: 'http://127.0.0.1:8045',
            placeholder: 'http://127.0.0.1:8045'
          },
          accountId: {
            type: 'text',
            title: '账号 ID',
            description: '网关账号的 id，见 ~/.antigravity_tools/accounts.json 的 current_account_id（或列表首项）',
            placeholder: '9af6d73c-…'
          },
          token: {
            title: 'API Key',
            description: '网关 API Key（Antigravity Tools 设置里查看），以 Bearer 头发送，加密保存'
          },
          pathsJson: { default: '' }
        },
        fetchStatus: antigravityQuotaStatus,
        test: async (settings, ctx2) => {
          const r = await antigravityQuotaStatus(settings, ctx2);
          return r.ok ? { ok: true, message: `连接成功，${(r.rows || []).length} 条配额` } : r;
        }
      })
    );
    console.log('[official-providers] registered 5 data source providers');
  }
});
