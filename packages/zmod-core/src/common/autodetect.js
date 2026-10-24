/**
 * Data source auto-detection.
 *
 * Scans well-known local credential stores (ZCode provider config, bl CLI,
 * Antigravity Tools) and returns per-type proposals:
 *   - status "ready": everything the provider needs was found locally; the
 *     settings object carries non-secret fields, `secrets` carries
 *     secret-typed ones (the renderer registry routes those into the vault).
 *   - status "placeholder": we know the account exists but the balance API
 *     needs credentials that are not derivable from what we found. The
 *     settings page renders these as dashed placeholder cards.
 *   - types already present in `existingTypes` are returned as "configured"
 *     so the UI can skip them.
 */

import fs from 'node:fs';
import path from 'node:path';

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** First non-disabled account id from ~/.antigravity_tools/accounts/*.json */
function detectAntigravityAccount(homeDir) {
  const dir = path.join(homeDir, '.antigravity_tools', 'accounts');
  let ids = [];
  try {
    ids = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJSON(path.join(dir, f)))
      .filter((a) => a && typeof a.id === 'string' && a.disabled !== true)
      .map((a) => a.id);
  } catch {}
  return ids[0] || null;
}

export function autodetectDatasources({ homeDir, existingTypes = [] }) {
  const home = homeDir || '';
  const proposals = [];
  const seen = new Set(); // type -> single proposal per type
  const existing = new Set(existingTypes);

  const add = (p) => {
    if (!p || seen.has(p.type)) return;
    seen.add(p.type);
    proposals.push({ ...p, status: existing.has(p.type) ? 'configured' : p.status });
  };

  /* ---- 1. ZCode provider config (the authority on what the user actually uses) ---- */
  const zc = readJSON(path.join(home, '.zcode', 'v2', 'provider_config.json'));
  const rules =
    zc?.config?.providerConfigRules?.providerRules ||
    zc?.providerConfigRules?.providerRules ||
    [];
  for (const rule of rules) {
    const baseUrl = rule?.config?.api?.baseUrl || '';
    const key = rule?.config?.access?.apiKey || '';
    const name = rule?.providerName || '';
    let host = '';
    try {
      host = baseUrl ? new URL(baseUrl).hostname : '';
    } catch {}

    if (/deepseek\.com$/.test(host) && key) {
      add({
        type: 'deepseek',
        name: 'DeepSeek 官方余额',
        status: 'ready',
        settings: { modelKeywords: 'deepseek' },
        secrets: { token: key },
        reason: `检测到 ZCode 供应商「${name}」使用 DeepSeek 官方 API`
      });
    } else if (host === '127.0.0.1' && /:8045/.test(baseUrl) && key) {
      const accountId = detectAntigravityAccount(home);
      if (accountId) {
        add({
          type: 'antigravity',
          name: 'Antigravity 网关',
          status: 'ready',
          settings: { url: 'http://127.0.0.1:8045', accountId, modelKeywords: 'gemini, claude, gpt, antigravity' },
          secrets: { token: key },
          reason: `检测到本地 Antigravity 网关供应商「${name}」`
        });
      }
    } else if (/api\.openai\.com$/.test(host)) {
      add({
        type: 'openai-compatible',
        name: 'OpenAI 官方',
        status: 'placeholder',
        settings: {},
        reason: 'OpenAI 未提供公开余额查询接口，无法自动获取'
      });
    } else if (/mimo|xiaomi/i.test(rule?.providerId || '') || /mimo/i.test(name)) {
      add({
        type: 'console-web',
        name: '小米 MiMo 控制台',
        status: 'placeholder',
        settings: {},
        reason: 'MiMo 余额需要控制台登录 Cookie，API Key 查不了'
      });
    }
  }

  /* ---- 2. bl CLI workspace key: balance needs a RAM key pair, sk-ws cannot ---- */
  const bl = readJSON(path.join(home, '.bailian', 'config.json'));
  if (bl?.api_key || /qwen|model-studio|bailian/i.test(JSON.stringify(rules.map((r) => r.providerId || '')))) {
    add({
      type: 'bailian-bss',
      name: '阿里云百炼资金账户',
      status: 'placeholder',
      settings: { modelKeywords: 'qwen, 百炼, bailian' },
      reason: '检测到百炼工作台密钥（sk-ws），但资金余额需要 RAM AccessKey 对（AliyunBSSReadOnlyAccess），sk-ws 查不了',
      guide: {
        url: 'https://ram.console.aliyun.com/manage/ak',
        text: '打开阿里云 RAM 控制台创建 AccessKey（建议子账号仅授 AliyunBSSReadOnlyAccess）'
      },
      quickFields: [
        { key: 'accessKeyId', title: 'AccessKey ID', type: 'text', placeholder: '粘贴 AccessKey ID' },
        { key: 'accessKeySecret', title: 'AccessKey Secret', type: 'secret', placeholder: '粘贴 AccessKey Secret' }
      ]
    });
  }

  return proposals;
}
