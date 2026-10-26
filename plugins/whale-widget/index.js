import { definePlugin } from '@zmod/sdk';
import { installV1Compat } from './v1-compat.js';

// 热更新时 entryUrl 的 ?v= 只落在 index.js；相对导入若不带同一查询串会命中
// 模块缓存，whale-impl 的 IIFE 不重跑、注册收集器为空。传播查询串 + 缓存
// 注册结果，使 update（重新执行本模块）与 disable→re-enable（复用本模块）两条路都成立。
const IMPL_QUERY = import.meta.url.includes('?') ? import.meta.url.slice(import.meta.url.indexOf('?')) : '';
let implEntry = null;

/**
 * Whale widget — v1 original ported to the v2 plugin spec, look & behavior
 * unchanged. The 1.4MB v1 implementation lives in ./whale-impl.js (generated
 * by tools/whale-port/build.mjs, assets externalized to ./assets/*) and runs
 * behind the ./v1-compat.js shim which provides the v1 base-class surface.
 */
export default definePlugin({
  id: 'whale-widget',
  name: 'DeepSeek 余额小鲸鱼（v1 原版移植）',
  version: '1.1.1',
  description: '桌宠 + 多供应商余额 + 账本记账 + 音效/角色/泡泡自定义 + 模型换装（v1 原样移植；数据源：遥测 + 外部供应商 API）',
  author: 'ZMod Team (upstream: MeteorNOX/DeepSeek-Balance-Whale-Widget)',

  async start(ctx) {
    const compat = installV1Compat(ctx);

    // The impl is an IIFE that registers itself through the shim collector.
    if (!implEntry) {
      await import('./whale-impl.js' + IMPL_QUERY);
      implEntry = compat.registered[compat.registered.length - 1] || null;
    }
    const entry = implEntry;
    if (!entry) {
      compat.uninstall();
      throw new Error('whale-impl.js registered no plugin (ZMod.Plugin missing at import time?)');
    }

    const inst = new entry.cls();
    if (typeof inst.onLoad === 'function') await inst.onLoad();
    if (typeof inst.onEnable === 'function') await inst.onEnable();

    ctx.cleanup(() => {
      try {
        if (typeof inst.onDisable === 'function') inst.onDisable();
      } catch (e) {
        console.error('[whale-widget] onDisable error:', e);
      }
      for (const d of inst._disposables || []) {
        try {
          typeof d === 'function' ? d() : null;
        } catch {}
      }
      compat.uninstall();
    });

    console.log(`[whale-widget] v1 port active: ${entry.meta?.name} v${entry.meta?.version}`);
  }
});
