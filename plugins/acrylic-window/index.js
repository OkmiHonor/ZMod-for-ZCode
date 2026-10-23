import { definePlugin } from '@zmod/sdk';

export default definePlugin({
  id: 'acrylic-window',
  name: '亚克力背板与老板键',
  description: 'Windows 11 DWM 亚克力/云母模糊全透背板，以及全局快捷键一键隐藏/恢复客户端',
  version: '2.0.0',
  author: 'ZMod Team',

  settings: {
    material: {
      type: 'select',
      title: '窗口材质',
      description: 'Windows 11 原生背景模糊材质',
      options: [
        { label: '亚克力 (Acrylic)', value: 'acrylic' },
        { label: '云母 (Mica)', value: 'mica' },
        { label: '关闭 (不透明)', value: 'none' }
      ],
      default: 'acrylic'
    },
    opacity: {
      type: 'slider',
      title: '背景底色透明度 (%)',
      description: '值越低越透亮，推荐 75% - 90%',
      default: 85,
      min: 20,
      max: 100
    },
    enableBosskey: {
      type: 'switch',
      title: '启用老板键',
      description: '使用全局热键快速最小化/呼出窗口',
      default: true
    },
    bosskeyShortcut: {
      type: 'text',
      title: '老板键快捷键',
      default: 'Alt+A'
    }
  },

  start({ settings, ui }) {
    const applyCSS = () => {
      const op = (settings.get('opacity', 85) / 100).toFixed(2);
      const css = `
        :root {
          --color-background: rgba(18, 18, 20, ${op}) !important;
          --color-surface: rgba(28, 28, 32, ${op}) !important;
        }
        body {
          background-color: transparent !important;
        }
      `;
      ui.injectStyle('acrylic-window-css', css);
    };

    applyCSS();
    settings.onChange('opacity', applyCSS);

    this._cleanup = () => {
      ui.removeStyle('acrylic-window-css');
    };
  },

  stop() {
    if (this._cleanup) this._cleanup();
  }
});
