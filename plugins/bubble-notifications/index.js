import { definePlugin } from '@zmod/sdk';
import { shouldShow, showParams, computeBubbleStyle } from './lib.js';

const BUBBLE_CSS = `
#zmod-bubble-hud-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  overflow: hidden;
}
.zmod-bubble-card {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 38px;
  padding: 0 18px;
  color: #202124;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(15, 23, 42, 0.14);
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 12px -6px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(8px);
  font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  pointer-events: auto;
  user-select: none;
  cursor: pointer;
  transform-origin: center center;
  transition: opacity 160ms ease, transform 160ms ease;
  animation: zmod-bubble-enter 160ms ease-out both;
}
.zmod-bubble-card[data-state="leaving"] {
  opacity: 0;
  transform: scale(0.92) !important;
}
@keyframes zmod-bubble-enter {
  from { opacity: 0; transform: translateY(-8px) scale(0.96); }
  to { opacity: 1; }
}
@media (prefers-color-scheme: dark) {
  .zmod-bubble-card {
    color: #f8fafc;
    background: rgba(35, 38, 43, 0.96);
    border-color: rgba(255, 255, 255, 0.14);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18), 0 6px 12px -6px rgba(0, 0, 0, 0.28);
  }
}
.zmod-bubble-card[data-theme="light"] {
  color: #202124 !important;
  background: rgba(255, 255, 255, 0.96) !important;
  border-color: rgba(15, 23, 42, 0.14) !important;
}
.zmod-bubble-card[data-theme="dark"] {
  color: #f8fafc !important;
  background: rgba(35, 38, 43, 0.96) !important;
  border-color: rgba(255, 255, 255, 0.14) !important;
}
.zmod-bubble-dots { display: flex; align-items: center; gap: 3px; }
.zmod-bubble-dot { width: 4px; height: 4px; border-radius: 50%; background: #d97706; animation: zmod-pulse 1.2s ease-in-out infinite; }
.zmod-bubble-dot:nth-child(2) { animation-delay: 120ms; }
.zmod-bubble-dot:nth-child(3) { animation-delay: 240ms; }
@keyframes zmod-pulse {
  0%, 70%, 100% { opacity: .35; transform: scale(.8); }
  35% { opacity: 1; transform: scale(1); }
}
`;

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getIconHtml(kind) {
  if (kind === 'waiting') {
    return '<span class="zmod-bubble-dots"><span class="zmod-bubble-dot"></span><span class="zmod-bubble-dot"></span><span class="zmod-bubble-dot"></span></span>';
  }
  const stroke = kind === 'error' ? '#dc2626' : (kind === 'success' ? '#16a34a' : '#2563eb');
  const path = kind === 'error'
    ? '<path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/>'
    : (kind === 'success' ? '<path d="M3.5 8.6l3 3L12.5 5"/>' : '<circle cx="8" cy="8" r="6.3"/><path d="M8 7.3v3.6"/><path d="M8 5v.1"/>');
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

class DomBubbleHudController {
  constructor(ui, snapGetter) {
    this.ui = ui;
    this.getSnap = snapGetter;
    this.card = null;
    this.hideTimer = null;
    this.layer = null;
  }
  ensureLayer() {
    if (!this.layer || !this.layer.isConnected) {
      this.ui.injectStyle('zmod-bubble-hud', BUBBLE_CSS);
      this.layer = document.getElementById('zmod-bubble-hud-layer');
      if (!this.layer) {
        this.layer = document.createElement('div');
        this.layer.id = 'zmod-bubble-hud-layer';
        const mount = document.getElementById('zmod-mount-portal') || document.body;
        mount.appendChild(this.layer);
      }
    }
    return this.layer;
  }
  show(spec) {
    const layer = this.ensureLayer();
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (!this.card || !this.card.isConnected) {
      this.card = document.createElement('div');
      this.card.className = 'zmod-bubble-card';
      this.card.addEventListener('click', () => this.hide());
      layer.appendChild(this.card);
    }
    this.card.removeAttribute('data-state');
    if (spec.theme && spec.theme !== 'auto') {
      this.card.setAttribute('data-theme', spec.theme);
    } else {
      this.card.removeAttribute('data-theme');
    }
    this.updatePosition();
    const text = spec.body ? `${escapeHtml(spec.title)} · ${escapeHtml(spec.body)}` : escapeHtml(spec.title);
    this.card.innerHTML = `${getIconHtml(spec.kind)}<span>${text}</span>`;

    if (!spec.pinned && spec.durationMs > 0) {
      this.hideTimer = setTimeout(() => this.hide(), spec.durationMs);
    }
  }
  updatePosition() {
    if (!this.card || !this.card.isConnected) return;
    const snap = this.getSnap();
    const style = computeBubbleStyle(snap);
    this.card.style.left = style.left;
    this.card.style.top = style.top;
    this.card.style.transform = style.transform;
  }
  hide() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.card && this.card.isConnected) {
      this.card.setAttribute('data-state', 'leaving');
      setTimeout(() => {
        if (this.card && this.card.getAttribute('data-state') === 'leaving') {
          this.card.remove();
          this.card = null;
        }
      }, 160);
    }
  }
  dispose() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.card) this.card.remove();
    if (this.layer) this.layer.remove();
    this.ui.removeStyle('zmod-bubble-hud');
  }
}

// definePlugin 的 actions 在 start 之前就定型，运行时句柄通过该槽位交接
let runtime = null;

export default definePlugin({
  // id/version 必须是字面量：manifest-consistency 测试按文本提取后与 manifest 对账
  id: 'bubble-notifications',
  name: '任务气泡通知',
  version: '0.2.0',
  description: '把任务通知以屏幕顶部气泡弹出：完成/出错/等待分类强调色，可配开关与停留时长，可自定义位置/大小/主题',
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
    livePreview: {
      type: 'switch',
      title: '常驻实时预览（所见即所得）',
      description: '开启后气泡常驻屏幕；调整位置、坐标、位移、缩放时实时跟手移动；调好后关闭即可',
      default: false
    },
    coordMode: {
      type: 'select',
      title: '定位方式',
      description: '选择「边缘停靠」或直接按「屏幕分辨率百分比坐标」定位',
      options: [
        { label: '边缘停靠 + 位移微调', value: 'preset' },
        { label: '屏幕分辨率坐标模式 (百分比)', value: 'coord' }
      ],
      default: 'preset'
    },
    coordX: {
      type: 'slider',
      title: '屏幕水平坐标 X（%）',
      description: '基于屏幕分辨率宽度的百分比（0% 最左，50% 居中，100% 最右，坐标模式下生效）',
      default: 50,
      min: 0,
      max: 100,
      step: 1
    },
    coordY: {
      type: 'slider',
      title: '屏幕垂直坐标 Y（%）',
      description: '基于屏幕分辨率高度的百分比（0% 顶部，50% 中间，95% 底部，坐标模式下生效）',
      default: 2,
      min: 0,
      max: 100,
      step: 1
    },
    position: {
      type: 'select',
      title: '弹出位置预设',
      description: '气泡在屏幕工作区内的停靠方向（停靠模式下生效）',
      options: [
        { label: '顶部居中', value: 'top-center' },
        { label: '顶部居左', value: 'top-left' },
        { label: '顶部居右', value: 'top-right' },
        { label: '底部居中', value: 'bottom-center' },
        { label: '底部居左', value: 'bottom-left' },
        { label: '底部居右', value: 'bottom-right' }
      ],
      default: 'top-center'
    },
    offsetX: {
      type: 'slider',
      title: '水平位移（像素）',
      description: '以设定位置为基准向左（负）或向右（正）平移像素距离',
      default: 0,
      min: -500,
      max: 500,
      step: 10
    },
    offsetY: {
      type: 'slider',
      title: '垂直位移（像素）',
      description: '以设定位置为基准向上（负）或向下（正）平移像素距离',
      default: 0,
      min: -500,
      max: 500,
      step: 10
    },
    margin: {
      type: 'slider',
      title: '屏幕边缘间距（像素）',
      description: '停靠模式下气泡外边缘距屏幕工作区边缘的基准距离',
      default: 12,
      min: 0,
      max: 200,
      step: 2
    },
    scale: {
      type: 'slider',
      title: '气泡缩放（%）',
      description: '整体放大/缩小气泡（60%–160%）',
      default: 100,
      min: 60,
      max: 160,
      step: 5
    },
    theme: {
      type: 'select',
      title: '主题',
      description: '浅色/深色配色，默认跟随系统',
      options: [
        { label: '跟随系统', value: 'auto' },
        { label: '浅色', value: 'light' },
        { label: '深色', value: 'dark' }
      ],
      default: 'auto'
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
    const KEYS = [
      'enabled',
      'onCompleted',
      'onFailed',
      'onWaiting',
      'duration',
      'focusShow',
      'livePreview',
      'coordMode',
      'coordX',
      'coordY',
      'position',
      'offsetX',
      'offsetY',
      'margin',
      'scale',
      'theme'
    ];
    const snap = {
      enabled: s.get('enabled', true) !== false,
      onCompleted: s.get('onCompleted', true) !== false,
      onFailed: s.get('onFailed', true) !== false,
      onWaiting: s.get('onWaiting', true) !== false,
      duration: Number(s.get('duration', 5000)) || 5000,
      focusShow: s.get('focusShow', false) === true,
      livePreview: s.get('livePreview', false) === true,
      coordMode: s.get('coordMode', 'preset'),
      coordX: Number(s.get('coordX', 50)),
      coordY: Number(s.get('coordY', 2)),
      position: s.get('position', 'top-center'),
      offsetX: Number(s.get('offsetX', 0)),
      offsetY: Number(s.get('offsetY', 0)),
      margin: Number(s.get('margin', 12)),
      scale: Number(s.get('scale', 100)),
      theme: s.get('theme', 'auto')
    };

    const domHud = new DomBubbleHudController(ctx.ui, () => snap);
    cleanup(() => domHud.dispose());

    const pushLivePreview = () => {
      if (!snap.livePreview) return;
      domHud.show({
        kind: 'info',
        title: '位置微调预览中',
        body: '拖动滑块实时跟手移动',
        pinned: true,
        theme: snap.theme
      });
      // 兼容支持主进程 HUD
      invoke('bubble.show', {
        kind: 'info',
        title: '位置微调预览中',
        body: '拖动滑块实时跟手移动',
        pinned: true,
        durationMs: 0,
        position: snap.position,
        coordMode: snap.coordMode,
        coordX: snap.coordX,
        coordY: snap.coordY,
        offsetX: snap.offsetX,
        offsetY: snap.offsetY,
        margin: snap.margin,
        scale: snap.scale / 100,
        theme: snap.theme
      }).catch(() => {});
    };

    for (const key of KEYS) {
      cleanup(
        s.onChange(key, () => {
          if (key === 'duration') snap.duration = Number(s.get('duration', 5000)) || 5000;
          else if (key === 'focusShow') snap.focusShow = s.get('focusShow', false) === true;
          else if (key === 'livePreview') {
            const next = s.get('livePreview', false) === true;
            snap.livePreview = next;
            if (next) pushLivePreview();
            else {
              domHud.hide();
              invoke('bubble.hide').catch(() => {});
            }
          }
          else if (key === 'coordMode') snap.coordMode = s.get('coordMode', 'preset');
          else if (key === 'coordX') snap.coordX = Number(s.get('coordX', 50));
          else if (key === 'coordY') snap.coordY = Number(s.get('coordY', 2));
          else if (key === 'position') snap.position = s.get('position', 'top-center');
          else if (key === 'offsetX') snap.offsetX = Number(s.get('offsetX', 0));
          else if (key === 'offsetY') snap.offsetY = Number(s.get('offsetY', 0));
          else if (key === 'margin') snap.margin = Number(s.get('margin', 12));
          else if (key === 'scale') snap.scale = Number(s.get('scale', 100));
          else if (key === 'theme') snap.theme = s.get('theme', 'auto');
          else snap[key] = s.get(key, true) !== false;

          // 若处于常驻预览模式，位置/缩放等变更时实时触发移动
          if (snap.livePreview && key !== 'livePreview') {
            domHud.updatePosition();
            pushLivePreview();
          }
        })
      );
    }

    const preview = () => {
      domHud.show({
        kind: 'success',
        title: '任务完成',
        body: '这是示例气泡',
        durationMs: snap.duration,
        theme: snap.theme
      });
      invoke('bubble.show', {
        kind: 'success',
        title: '任务完成',
        body: '这是示例气泡',
        durationMs: snap.duration,
        position: snap.position,
        coordMode: snap.coordMode,
        coordX: snap.coordX,
        coordY: snap.coordY,
        offsetX: snap.offsetX,
        offsetY: snap.offsetY,
        margin: snap.margin,
        scale: snap.scale / 100,
        theme: snap.theme
      }).catch(() => {});
    };

    /* ---- 通知事件：主进程 tap 经 preload 桥 sender 定向转发 → 气泡 HUD ---- */
    const seen = new Map(); // dedupeKey -> first-seen ts
    const onNotification = (evt) => {
      try {
        if (!shouldShow(evt, snap, seen, Date.now())) return;
        const p = showParams(evt, snap);
        domHud.show(p);
        invoke('bubble.show', p).catch(() => {});
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
      if (snap.livePreview) {
        domHud.hide();
        invoke('bubble.hide').catch(() => {});
      }
      runtime = null;
    });

    runtime = { preview };
    console.log('[ZMod:BubbleNotify] armed (DOM HUD + host fallback)');
  },

  async stop() {
    /* teardown handled via ctx.cleanup */
  }
});
