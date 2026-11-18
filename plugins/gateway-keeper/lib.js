/**
 * @file lib.js - Gateway Keeper 纯函数业务逻辑
 * 零 DOM、零 SDK 依赖，100% 可在 Node.js 环境下运行单元测试。
 */

/**
 * 解析用户输入的关键词字符串为关键词数组
 * 支持英文逗号、中文逗号、分号（中英文）、换行分隔
 * 转换为小写并去除首尾空白，空值返回空数组 []
 *
 * @param {string|unknown} keywordsStr
 * @returns {string[]}
 */
export function parseKeywords(keywordsStr) {
  if (typeof keywordsStr !== 'string' || !keywordsStr.trim()) {
    return [];
  }
  return keywordsStr
    .split(/[,，;；\r\n]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 根据当前模型名称与网关列表进行匹配
 * 遍历已启用的网关，若 modelName（小写）包含关键词列表中的任一词（不区分大小写），即返回该网关
 *
 * @param {string} modelName
 * @param {Array<{ id: string, name: string, enabled: boolean, path: string, url: string, keywords: string|string[] }>} gateways
 * @returns {object|null} 命中的网关对象或 null
 */
export function matchGateway(modelName, gateways) {
  if (typeof modelName !== 'string' || !modelName.trim() || !Array.isArray(gateways)) {
    return null;
  }
  const lowerName = modelName.trim().toLowerCase();
  for (const gw of gateways) {
    if (!gw || !gw.enabled) continue;
    const kwList = Array.isArray(gw.keywords)
      ? gw.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
      : parseKeywords(gw.keywords);
    for (const kw of kwList) {
      if (kw && lowerName.includes(kw)) {
        return gw;
      }
    }
  }
  return null;
}

/**
 * 探活网关 HTTP 服务是否在线
 * 通过 netFetch 发起 GET 请求，若 status 介于 200~499 或 ok === true，说明 HTTP 端口已正常监听
 *
 * @param {string} url
 * @param {Function} netFetch - 异步请求函数，签名为 ({ url, timeoutMs, method }) => Promise<res>
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<{ alive: boolean, status?: number, error?: string }>}
 */
export async function checkGatewayAlive(url, netFetch, timeoutMs = 1500) {
  if (!url || typeof netFetch !== 'function') {
    return { alive: false, error: 'invalid_params' };
  }
  try {
    const res = await netFetch({ url, timeoutMs, method: 'GET' });
    const status = typeof res?.status === 'number' ? res.status : 0;
    if ((status >= 200 && status < 500) || res?.ok === true) {
      return { alive: true, status: status || (res?.ok ? 200 : 0) };
    }
    return { alive: false, error: res?.error || 'offline' };
  } catch (e) {
    return { alive: false, error: String(e?.message || e) };
  }
}

/**
 * 检查网关是否处于启动冷却完毕就绪状态（防抖）
 *
 * @param {string} gatewayId
 * @param {Record<string, number>} lastLaunchMap
 * @param {number} [cooldownMs=15000]
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function canLaunch(gatewayId, lastLaunchMap, cooldownMs = 15000, now = Date.now()) {
  if (!gatewayId || !lastLaunchMap) return true;
  const last = Number(lastLaunchMap[gatewayId]) || 0;
  return (now - last) >= cooldownMs;
}

/**
 * 记录网关启动时间戳
 *
 * @param {string} gatewayId
 * @param {Record<string, number>} lastLaunchMap
 * @param {number} [now=Date.now()]
 * @returns {number} 记录的时间戳
 */
export function recordLaunch(gatewayId, lastLaunchMap, now = Date.now()) {
  const ts = typeof now === 'number' ? now : Date.now();
  if (gatewayId && lastLaunchMap && typeof lastLaunchMap === 'object') {
    lastLaunchMap[gatewayId] = ts;
  }
  return ts;
}

/**
 * 清洗从 DOM 提取的文字：去除控制字符、前后空白、折叠换行和连续空格
 *
 * @param {string} rawText
 * @returns {string}
 */
export function extractModelFromDomText(rawText) {
  if (typeof rawText !== 'string') return '';
  return rawText
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
