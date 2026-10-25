import { definePlugin } from '@zmod/sdk';

/**
 * Zero-credential account quota — passive reader of the official entitlement
 * data. Two channels, both zero-request:
 *
 * 1. Port sniffer (best effort): the main process hands the renderer a
 *    MessagePort to the host service broker (`zcode:service-port`, relayed
 *    into the page via window.postMessage). Frames broadcast to every
 *    listener, so entitlement-shaped responses/event-pushes can be captured.
 *    NOTE: the relay usually fires before plugin listeners register, so this
 *    channel only lands in some boots — it is a bonus, not the primary path.
 *
 * 2. Official usage popover DOM (primary): when the official 上下文容量
 *    hover-card opens it renders the 今日余额 cards (model · remaining% ·
 *    reset date). We parse those rows on the fly.
 *
 * Frame format (reversed from out/renderer bundles): tag-byte + LEB128-length
 * payloads — 0 undefined · 1 string · 2/3 bytes · 4 array · 5 JSON · 6 varint;
 * request [100, id, channel, method] + arg; response [201/202/203, id] + data;
 * event push [204, id] + data.
 */

const MSG_PROMISE_SUCCESS = 201;
const MSG_EVENT_FIRE = 204;
const REQ_PROMISE = 100;
const TARGET_CHANNEL = 'usage-stats';
const TARGET_METHOD = 'getEntitlementSnapshot';

function readVarint(r) {
  let value = 0, shift = 0;
  for (;;) {
    const byte = r.buf[r.pos++];
    value += (byte & 127) * Math.pow(2, shift);
    if (!(byte & 128)) return value;
    shift += 7;
  }
}

function readValue(r) {
  const tag = r.buf[r.pos++];
  switch (tag) {
    case 0: return undefined;
    case 1: {
      const len = readVarint(r);
      const s = r.buf.slice(r.pos, r.pos + len);
      r.pos += len;
      return new TextDecoder().decode(s);
    }
    case 2: case 3: {
      const len = readVarint(r);
      r.pos += len;
      return null;
    }
    case 4: {
      const n = readVarint(r);
      const a = [];
      for (let i = 0; i < n; i++) a.push(readValue(r));
      return a;
    }
    case 5: {
      const len = readVarint(r);
      const s = r.buf.slice(r.pos, r.pos + len);
      r.pos += len;
      return JSON.parse(new TextDecoder().decode(s));
    }
    case 6: return readVarint(r);
    default: return undefined;
  }
}

function decodeFrame(bytes) {
  try {
    const r = { buf: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), pos: 0 };
    const head = readValue(r);
    if (!Array.isArray(head) || head.length < 2) return null;
    const data = readValue(r);
    return { head, data };
  } catch {
    return null;
  }
}

function looksLikeEntitlement(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  if (keys.includes('ack') && keys.length <= 2) return false;
  return ['subscription', 'quota', 'remaining', 'entitlement', 'entitlements', 'limits'].some((k) => keys.includes(k));
}

/** Parse "今日余额" rows out of the official hover-card DOM.
 *  Row structure (3.16.3): grid cell per model —
 *    name div.truncate, value span.font-mono ("63%"), date span (" · 10月26日"). */
function rowsFromPopover(host) {
  const rows = [];
  // the balance section contains the header AND model rows (percent + reset date);
  // header-only divs also contain the literal 今日余额, so require a date too
  const sections = [...host.querySelectorAll('div')].filter(
    (d) => /今日余额/.test(d.textContent || '') && /\d{1,2}月\d{1,2}日/.test(d.textContent || '')
  );
  const section = sections[sections.length - 1];
  if (!section) return rows;
  const cells = section.querySelectorAll('div[class*="space-y-1.5"]');
  for (const cell of cells) {
    const name = cell.querySelector('div.truncate, [class*="truncate"]')?.textContent?.trim();
    const spans = [...cell.querySelectorAll('span')];
    const pctSpan = spans.find((s) => /^\d+(\.\d+)?%$/.test(s.textContent?.trim() || ''));
    if (!name || !pctSpan) continue;
    const date = spans.find((s) => /\d{1,2}月\d{1,2}日/.test(s.textContent || ''))?.textContent?.trim() || '';
    rows.push({ label: name, value: `${Math.round(parseFloat(pctSpan.textContent))}% 剩余${date ? ' · ' + date.replace(/^\s*·\s*/, '') : ''}` });
  }
  return rows;
}

export default definePlugin({
  id: 'account-quota',
  name: '账号额度（零凭据）',
  version: '1.0.0-beta',
  description: '被动读取官方登录账号的今日余额/配额（官方弹窗打开即刷新），无需任何 API Key',
  author: 'ZMod Team',

  async start(ctx) {
    const { cleanup } = ctx;
    let latest = null; // { rows, source, at }

    const publish = () => {
      try {
        window.__zmod_account_quota__ = latest && {
          rows: latest.rows,
          source: latest.source,
          observedAt: latest.at
        };
      } catch {}
    };
    publish();

    /* ---- datasource type: the passive snapshot as a first-class source ----
       Collection stays here (this plugin owns official-account observation);
       registering it as a provider lets any datasource consumer (浮窗/设置页)
       use it like any other source — zero credentials, zero requests. */
    const ds = ctx.datasources;
    if (ds) {
      ds.registerProvider({
        type: 'official-account',
        label: '官方账号额度（零凭据）',
        description: '被动读取官方登录账号的今日余额/配额（悬停输入框「上下文容量」打开官方弹窗即刷新），无需任何 API Key',
        settings: {
          modelKeywords: {
            title: '供应商/模型匹配关键字（可选）',
            description: '逗号分隔。当前选中的供应商名或模型名含任一关键字时，用量浮窗显示此源；留空则按实例名称相似度自动匹配',
            placeholder: 'glm, zai'
          }
        },
        fetchStatus: async () => {
          const q = window.__zmod_account_quota__;
          if (q && Array.isArray(q.rows) && q.rows.length > 0) {
            return { ok: true, rows: q.rows, ts: q.observedAt };
          }
          return { ok: false, message: '暂无采集数据 — 悬停输入框「上下文容量」打开官方弹窗即可采集（零凭据，不发任何请求）' };
        },
        test: async () => {
          const q = window.__zmod_account_quota__;
          return q && Array.isArray(q.rows) && q.rows.length > 0
            ? { ok: true, message: `已有 ${q.rows.length} 条采集数据` }
            : { ok: false, message: '暂无采集数据 — 打开一次官方用量弹窗后重试' };
        }
      });
      console.log('[account-quota] registered official-account datasource provider');
    }

    /* ---- channel 2 (primary): official popover DOM ---- */
    const popObserver = new MutationObserver(() => {
      for (const pop of document.querySelectorAll('[data-slot="hover-card-content"]')) {
        if (!pop.isConnected || pop.getAttribute('data-zmod-acct-observed') === '1') continue;
        pop.setAttribute('data-zmod-acct-observed', '1');
        const rows = rowsFromPopover(pop);
        if (rows.length > 0) {
          latest = { rows, source: 'official-popover', at: Date.now() };
          publish();
          console.log('[account-quota] captured 今日余额 rows from official popover:', rows.map((r) => r.label + ' ' + r.value).join(' | '));
        }
      }
    });
    popObserver.observe(document.body, { childList: true, subtree: true });
    cleanup(() => popObserver.disconnect());

    /* ---- channel 1 (bonus): service-port frame sniffer ---- */
    const pendingIds = new Map();
    const onMessage = (ev) => {
      const d = ev.data;
      if (!d || d.type !== 'zcode:service-port' || !ev.ports || !ev.ports.length) return;
      const port = ev.ports[0];
      port.addEventListener('message', (msg) => {
        const frame = decodeFrame(msg.data);
        if (!frame) return;
        const [type, id] = frame.head;
        if (type === REQ_PROMISE && frame.head.length >= 4 && frame.head[2] === TARGET_CHANNEL && frame.head[3] === TARGET_METHOD) {
          pendingIds.set(id, true);
          if (pendingIds.size > 20) pendingIds.delete(pendingIds.keys().next().value);
        } else if (type === MSG_PROMISE_SUCCESS && pendingIds.has(id) && looksLikeEntitlement(frame.data)) {
          pendingIds.delete(id);
          latest = { rows: [], snapshot: frame.data, source: 'service-port', at: Date.now() };
          publish();
          console.log('[account-quota] captured entitlement snapshot (service-port response)');
        } else if (type === MSG_EVENT_FIRE && looksLikeEntitlement(frame.data)) {
          latest = { rows: [], snapshot: frame.data, source: 'service-port', at: Date.now() };
          publish();
          console.log('[account-quota] captured entitlement snapshot (service-port event push)');
        }
      });
      // NEVER call port.start() here: the official client starts the flow itself
      // after boot; an early start() flushes queued server frames before the
      // official listener attaches and stalls app boot (verified empirically).
    };
    window.addEventListener('message', onMessage);
    cleanup(() => window.removeEventListener('message', onMessage));

    cleanup(() => {
      try { delete window.__zmod_account_quota__; } catch {}
    });
    console.log('[account-quota] passive account-quota reader armed');
  }
});
