import { definePlugin } from '@zmod/sdk';
import { shouldShow, showParams } from './lib.js';

// definePlugin 的 actions 在 start 之前就定型，运行时句柄通过该槽位交接
let runtime = null;

export default definePlugin({
  // id/version 必须是字面量：manifest-consistency 测试按文本提取后与 manifest 对账
  id: 'bubble-notifications',
  name: '任务气泡通知',
  version: '0.1.0',
  description: '把任务通知以屏幕顶部气泡弹出：完成/出错/等待分类强调色，可配开关与停留时长',
  author: 'ZMod Team',

  settings: {
    enabled: {
      type: 'switch',
      title: '启用气泡通知',
      default: true
    },
    onCompleted: {
      type: 'switch',
      title: '任务完成',
      description: '绿色对勾气泡',
      default: true
    },
    onFailed: {
      type: 'switch',
      title: '任务出错',
      description: '红色叉号气泡',
      default: true
    },
    onWaiting: {
      type: 'switch',
      title: '等待确认/输入',
      description: '琥珀色脉动圆点气泡（权限确认、补充信息）',
      default: true
    },
    duration: {
      type: 'slider',
      title: '气泡停留时长（毫秒）',
      description: '超时后气泡自动淡出',
      default: 5000,
      min: 1000,
      max: 15000,
      step: 500
    },
    focusShow: {
      type: 'switch',
      title: '窗口聚焦时也弹',
      description: '官方通知窗口聚焦时静默；开启后聚焦状态同样弹气泡',
      default: false
    },
    preview: {
      type: 'action',
      title: '试弹示例气泡',
      action: 'preview'
    }
  },

  actions: {
    preview: {
      title: '试弹示例气泡',
      run: async () => {
        if (!runtime) return { ok: false, message: '插件尚未启动' };
        await runtime.preview();
        return { ok: true };
      }
    }
  },

  async start(ctx) {
    const { invoke, cleanup } = ctx;
    const s = ctx.settings;

    /* ---- 可变快照：热路径（每个通知）不碰 RPC，只读这里 ---- */
    const KEYS = ['enabled', 'onCompleted', 'onFailed', 'onWaiting', 'duration', 'focusShow'];
    const snap = {
      enabled: s.get('enabled', true) !== false,
      onCompleted: s.get('onCompleted', true) !== false,
      onFailed: s.get('onFailed', true) !== false,
      onWaiting: s.get('onWaiting', true) !== false,
      duration: Number(s.get('duration', 5000)) || 5000,
      focusShow: s.get('focusShow', false) === true
    };
    for (const key of KEYS) {
      cleanup(
        s.onChange(key, () => {
          if (key === 'duration') snap.duration = Number(s.get('duration', 5000)) || 5000;
          else if (key === 'focusShow') snap.focusShow = s.get('focusShow', false) === true;
          else snap[key] = s.get(key, true) !== false;
        })
      );
    }

    const preview = () =>
      invoke('bubble.show', {
        kind: 'success',
        title: '任务完成',
        body: '这是示例气泡',
        durationMs: snap.duration
      });

    /* ---- 通知事件：主进程 tap 经 preload 桥 sender 定向转发 → 气泡 HUD ---- */
    const seen = new Map(); // dedupeKey -> first-seen ts
    const onNotification = (evt) => {
      try {
        if (!shouldShow(evt, snap, seen, Date.now())) return;
        invoke('bubble.show', showParams(evt, snap)).catch((err) => {
          console.error('[ZMod:BubbleNotify] bubble.show failed:', err?.message || err);
        });
      } catch (err) {
        console.error('[ZMod:BubbleNotify] notification handler error:', err?.message || err);
      }
    };
    const bridge = typeof window !== 'undefined' ? window.zmodAPI : null;
    if (bridge && typeof bridge.on === 'function') {
      cleanup(bridge.on('zmod:notification-event', onNotification));
    } else {
      console.warn('[ZMod:BubbleNotify] preload bridge unavailable — no bubble notifications');
    }

    cleanup(() => {
      runtime = null;
    });

    runtime = { preview };
    console.log('[ZMod:BubbleNotify] armed (completed/failed/permission_request/elicitation_request → bubble)');
  },

  async stop() {
    /* teardown handled via ctx.cleanup */
  }
});
