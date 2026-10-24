import { definePlugin } from '@zmod/sdk';

export default definePlugin({
  id: 'acrylic-window',
  name: '亚克力背板与老板键',
  description: 'Windows 11 亚克力/云母窗口背板（主进程 setBackgroundMaterial）+ 全局老板键一键隐藏/呼出',
  version: '2.0.0',
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
    const { settings, ui, invoke, cleanup } = ctx;

    ui.injectStyle(
      'acrylic-window-css',
      'html, body, #root { background: transparent !important; }'
    );

    const applyMaterial = async () => {
      const material = settings.get('material', 'acrylic');
      const tint = settings.get('tint', '#00000000');
      try {
        const res = await invoke('window.setMaterial', { material, tint });
        if (res && res.supported === false && material !== 'none') {
          ui.showToast('当前系统不支持该窗口材质，已保持不透明', 'warn');
        }
      } catch (err) {
        console.error('[ZMod:Acrylic] setMaterial failed:', err?.message || err);
      }
    };

    const applyBossKey = async () => {
      try {
        if (settings.get('enableBosskey', false)) {
          const accelerator = settings.get('bosskeyShortcut', 'Alt+A');
          const res = await invoke('window.registerBossKey', { accelerator });
          if (res && res.success === false) {
            ui.showToast(`老板键 ${accelerator} 注册失败`, 'warn');
          }
        } else {
          await invoke('window.unregisterBossKey', {});
        }
      } catch (err) {
        console.error('[ZMod:Acrylic] boss key failed:', err?.message || err);
      }
    };

    await applyMaterial();
    await applyBossKey();

    cleanup(() => {
      invoke('window.unregisterBossKey', {}).catch(() => {});
      invoke('window.setMaterial', { material: 'none' }).catch(() => {});
    });

    settings.onChange('material', applyMaterial);
    settings.onChange('tint', applyMaterial);
    settings.onChange('enableBosskey', applyBossKey);
    settings.onChange('bosskeyShortcut', applyBossKey);
  },

  async stop() {
    /* teardown handled via ctx.cleanup */
  }
});
