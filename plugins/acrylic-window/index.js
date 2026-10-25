import { definePlugin } from '@zmod/sdk';

function pct(v) {
  return Math.round(Math.min(Math.max(Number(v) || 50, 30), 100));
}

/**
 * Semantic background variables of the official dark themes, made translucent
 * via color-mix so the DWM acrylic/mica material shows through the UI.
 * Base colors mirror the official .theme-zai-dark palette (v1 ui-customizer).
 */
function acrylicCss(panelOp, sidebarOp, popoverOp) {
  const pc = pct(panelOp);
  const sc = pct(sidebarOp);
  const oc = pct(popoverOp);
  return `
    html, body { background: transparent !important; }
    .dark, .theme-zai-dark {
      --color-background: color-mix(in srgb, #161616 ${pc}%, transparent) !important;
      --color-background-win-alt: color-mix(in srgb, #2b2b2b ${pc}%, transparent) !important;
      --color-header: color-mix(in srgb, #202020 ${pc}%, transparent) !important;
      --color-panel: color-mix(in srgb, #202020 ${pc}%, transparent) !important;
      --color-sidebar: color-mix(in srgb, #161616 ${sc}%, transparent) !important;
      --color-card: color-mix(in srgb, #2b2b2b ${pc}%, transparent) !important;
      --color-card-selected: color-mix(in srgb, #363636 ${pc}%, transparent) !important;
      --color-popover: color-mix(in srgb, #2b2b2b ${oc}%, transparent) !important;
      --color-popover-header: color-mix(in srgb, #202020 ${oc}%, transparent) !important;
      --color-input: color-mix(in srgb, #2b2b2b ${pc}%, transparent) !important;
      --color-tab: color-mix(in srgb, #202020 ${pc}%, transparent) !important;
      --color-tab-active: color-mix(in srgb, #161616 ${pc}%, transparent) !important;
      --color-menu: color-mix(in srgb, #2b2b2b ${oc}%, transparent) !important;
      --color-menu-hover: color-mix(in srgb, #363636 ${oc}%, transparent) !important;
      --color-tooltip: color-mix(in srgb, #2b2b2b ${oc}%, transparent) !important;
      --color-tooltip-tag: color-mix(in srgb, #363636 ${oc}%, transparent) !important;
    }
  `;
}

export default definePlugin({
  id: 'acrylic-window',
  name: '亚克力背板与老板键',
  description: 'Windows 11 亚克力/云母窗口（系统材质 + 官方主题底色透明化）+ 全局老板键',
  version: '2.1.0',
  author: 'ZMod Team',

  settings: {
    material: {
      type: 'select',
      title: '窗口材质',
      description: 'Windows 11 原生背景模糊材质（22H2+），失败时自动保持不透明',
      options: [
        { label: '亚克力 (Acrylic)', value: 'acrylic' },
        { label: '云母 (Mica)', value: 'mica' },
        { label: '关闭 (不透明)', value: 'none' }
      ],
      default: 'acrylic'
    },
    tint: {
      type: 'text',
      title: '背板底色 (RGBA)',
      description: '叠加在模糊材质上的底色，#00000000 表示全透明',
      default: '#00000000'
    },
    uiTransparency: {
      type: 'group',
      title: '界面透明度（材质开启时生效，暗色主题）'
    },
    panelOpacity: {
      type: 'slider',
      title: '面板/卡片透明度',
      description: '聊天区与卡片的底色不透明度（百分比）',
      default: 50,
      min: 30,
      max: 100,
      step: 1
    },
    sidebarOpacity: {
      type: 'slider',
      title: '侧栏透明度',
      default: 65,
      min: 30,
      max: 100,
      step: 1
    },
    popoverOpacity: {
      type: 'slider',
      title: '弹层/菜单透明度',
      default: 88,
      min: 30,
      max: 100,
      step: 1
    },
    bosskeyGroup: {
      type: 'group',
      title: '老板键'
    },
    enableBosskey: {
      type: 'switch',
      title: '启用老板键',
      description: '全局热键：焦点中隐藏窗口，再次按下呼出并聚焦',
      default: false
    },
    bosskeyShortcut: {
      type: 'text',
      title: '老板键快捷键',
      description: 'Electron accelerator 格式，如 Alt+A / Control+Shift+Z',
      default: 'Alt+A'
    }
  },

  async start(ctx) {
    const { settings: s, ui: u, invoke } = ctx;

    const applyMaterial = async () => {
      const material = s.get('material', 'acrylic');
      const tint = s.get('tint', '#00000000');
      try {
        const res = await invoke('window.setMaterial', { material, tint });
        if (res && res.supported === false && material !== 'none') {
          u.showToast('当前系统不支持该窗口材质，已保持不透明', 'warn');
        }
      } catch (err) {
        console.error('[ZMod:Acrylic] setMaterial failed:', err?.message || err);
      }
    };

    const applyTransparency = () => {
      if (s.get('material', 'acrylic') === 'none') {
        u.removeStyle('acrylic-window-theme');
        return;
      }
      u.injectStyle(
        'acrylic-window-theme',
        acrylicCss(s.get('panelOpacity', 50), s.get('sidebarOpacity', 65), s.get('popoverOpacity', 88))
      );
    };

    const applyBossKey = async () => {
      try {
        if (s.get('enableBosskey', false)) {
          const accelerator = s.get('bosskeyShortcut', 'Alt+A');
          const res = await invoke('window.registerBossKey', { accelerator });
          if (res && res.success === false) {
            u.showToast(`老板键 ${accelerator} 注册失败`, 'warn');
          }
        } else {
          await invoke('window.unregisterBossKey', {});
        }
      } catch (err) {
        console.error('[ZMod:Acrylic] boss key failed:', err?.message || err);
      }
    };

    await applyMaterial();
    applyTransparency();
    await applyBossKey();

    ctx.cleanup(() => {
      invoke('window.unregisterBossKey', {}).catch(() => {});
      invoke('window.setMaterial', { material: 'none' }).catch(() => {});
      u.removeStyle('acrylic-window-theme');
    });

    s.onChange('material', async () => {
      await applyMaterial();
      applyTransparency();
    });
    s.onChange('tint', applyMaterial);
    s.onChange('panelOpacity', applyTransparency);
    s.onChange('sidebarOpacity', applyTransparency);
    s.onChange('popoverOpacity', applyTransparency);
    s.onChange('enableBosskey', applyBossKey);
    s.onChange('bosskeyShortcut', applyBossKey);
  },

  async stop() {
    /* teardown handled via ctx.cleanup */
  }
});
