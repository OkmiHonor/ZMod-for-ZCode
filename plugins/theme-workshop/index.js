import { definePlugin } from '@zmod/sdk';
import { ALL_KEYS, DEFAULTS, PRESETS, buildCss } from './lib.js';

const PRESET_LABELS = {
  vanilla: '一键还原原版',
  frost: '极简毛玻璃',
  warm: '护眼暖阳',
  cyber: '赛博流光',
  desktop: '透出桌面（原生材质）'
};

const WALLPAPER_PATH_HINT = 'D:\\ZMod\\data\\plugins\\theme-workshop\\wallpapers\\';

export default definePlugin({
  id: 'theme-workshop',
  name: '外观与主题工坊',
  description: '把设置实时翻译成整套界面皮肤：壁纸、分区透明度、圆角字号字体、面板毛玻璃与窗口材质，停用即还原',
  version: '0.1.0',
  author: 'ZMod Team',

  settings: {
    presetGroup: { type: 'group', title: '第一步 · 预设主题' },
    preset: {
      type: 'select',
      title: '预设主题',
      description: '选择即套用整套快照，之后手动微调不会改变此选项',
      options: [
        { label: '一键还原原版', value: 'vanilla' },
        { label: '极简毛玻璃', value: 'frost' },
        { label: '护眼暖阳', value: 'warm' },
        { label: '赛博流光', value: 'cyber' },
        { label: '透出桌面（原生材质）', value: 'desktop' },
        { label: '自定义（自由调整）', value: 'custom' }
      ],
      default: 'frost'
    },
    reapplyPreset: {
      type: 'action',
      title: '重新应用当前预设',
      description: '微调乱了想回到预设原貌时点这里',
      action: 'reapplyPreset'
    },

    wallpaperGroup: { type: 'group', title: '第二步 · 壁纸' },
    wallpaperMode: {
      type: 'select',
      title: '壁纸来源',
      description:
        '自定义图片需先把文件放入插件目录 wallpapers 文件夹（见插件说明），再在下一项填文件名',
      options: [
        { label: '关闭壁纸', value: 'none' },
        { label: '内置渐变背景', value: 'builtin' },
        { label: '自定义图片', value: 'custom' }
      ],
      default: 'builtin'
    },
    builtinWallpaper: {
      type: 'select',
      title: '内置壁纸',
      options: [
        { label: '晨雾青灰', value: 'aurora' },
        { label: '暖阳杏橘', value: 'sunset' },
        { label: '深空紫蓝', value: 'cyber' },
        { label: '松林墨绿', value: 'forest' }
      ],
      default: 'aurora'
    },
    wallpaperFile: {
      type: 'text',
      title: '壁纸文件名',
      placeholder: '例如 my-wallpaper.png',
      description: '仅自定义图片模式生效，填放进的图片文件名（含扩展名）',
      default: ''
    },
    wallpaperFit: {
      type: 'select',
      title: '图片填充方式',
      options: [
        { label: '铺满裁切', value: 'cover' },
        { label: '完整显示', value: 'contain' },
        { label: '平铺重复', value: 'repeat' }
      ],
      default: 'cover'
    },
    wallpaperBrightness: {
      type: 'slider',
      title: '壁纸亮度 %',
      description: '觉得壁纸太抢眼就调低',
      default: 100,
      min: 20,
      max: 100,
      step: 1
    },
    wallpaperBlur: {
      type: 'slider',
      title: '壁纸模糊 px',
      default: 0,
      min: 0,
      max: 40,
      step: 1
    },
    wallpaperVignette: {
      type: 'slider',
      title: '四角暗角 %',
      description: '四周压暗，突出中间内容',
      default: 30,
      min: 0,
      max: 80,
      step: 1
    },
    panelFrost: {
      type: 'slider',
      title: '面板毛玻璃 px',
      description: '给四大面板加毛玻璃，大幅模糊会增加 GPU 占用，0 为关闭',
      default: 0,
      min: 0,
      max: 30,
      step: 1
    },

    opacityGroup: {
      type: 'group',
      title: '第三步 · 分区透明度（100 = 原版不透明，越小越透）'
    },
    opBackground: {
      type: 'slider',
      title: '主背景',
      default: 70,
      min: 0,
      max: 100,
      step: 1
    },
    opSidebar: {
      type: 'slider',
      title: '侧边栏',
      default: 55,
      min: 0,
      max: 100,
      step: 1
    },
    opHeader: {
      type: 'slider',
      title: '顶栏与标签',
      default: 62,
      min: 0,
      max: 100,
      step: 1
    },
    opPanel: {
      type: 'slider',
      title: '右侧面板',
      default: 66,
      min: 0,
      max: 100,
      step: 1
    },
    opCard: {
      type: 'slider',
      title: '卡片',
      default: 85,
      min: 0,
      max: 100,
      step: 1
    },
    opInput: {
      type: 'slider',
      title: '输入框',
      default: 78,
      min: 0,
      max: 100,
      step: 1
    },
    opMenu: {
      type: 'slider',
      title: '弹窗与菜单',
      description: '建议保持较高值，太透会影响菜单可读性',
      default: 92,
      min: 0,
      max: 100,
      step: 1
    },
    opBubble: {
      type: 'slider',
      title: '用户消息气泡',
      default: 55,
      min: 0,
      max: 100,
      step: 1
    },
    opTerminal: {
      type: 'slider',
      title: '内置终端',
      default: 82,
      min: 0,
      max: 100,
      step: 1
    },
    opCode: {
      type: 'slider',
      title: '代码块与行内代码',
      default: 85,
      min: 0,
      max: 100,
      step: 1
    },

    typographyGroup: { type: 'group', title: '第四步 · 排版' },
    radius: {
      type: 'slider',
      title: '全局圆角 px',
      description: '6 为官方默认值',
      default: 6,
      min: 0,
      max: 24,
      step: 1
    },
    fontSize: {
      type: 'slider',
      title: '全局基准字号 px',
      description: '14 为官方默认值',
      default: 14,
      min: 12,
      max: 18,
      step: 1
    },
    fontUi: {
      type: 'text',
      title: '界面字体名',
      description: '需系统已安装该字体，留空不修改',
      default: ''
    },
    fontMono: {
      type: 'text',
      title: '代码与终端字体名',
      description: '需系统已安装该字体，留空不修改',
      default: ''
    },

    materialGroup: { type: 'group', title: '第五步 · 窗口材质（Windows 11 22H2+）' },
    material: {
      type: 'select',
      title: '窗口材质',
      description:
        '切换窗口底材。注意：本机出厂默认就是亚克力，且壁纸层/不透明分区会盖住底材——想看见效果，请选「透出桌面」预设，或把「壁纸来源」设为关闭并调低主背景透明度',
      options: [
        { label: '不修改（保持系统默认）', value: 'keep' },
        { label: '亚克力（模糊透出桌面，= 系统默认）', value: 'acrylic' },
        { label: '云母（更柔和的桌面渗色）', value: 'mica' }
      ],
      default: 'keep'
    }
  },

  actions: {
    reapplyPreset: {
      title: '重新应用当前预设',
      run: async (ctx) => {
        const key = ctx.settings.get('preset', DEFAULTS.preset);
        const snapshot = PRESETS[key];
        if (!snapshot) {
          return { ok: false, message: '当前是自定义配置，请先选择一个预设' };
        }
        // 重写 preset 键触发 onChange → start 里的 applyPresetSnapshot 原子套用
        await ctx.settings.set('preset', key);
        return { ok: true, message: `已应用预设：${PRESET_LABELS[key] || key}` };
      }
    }
  },

  async start(ctx) {
    const { settings: s, ui: u, invoke } = ctx;

    const current = () => {
      const out = {};
      for (const k of ALL_KEYS) out[k] = s.get(k, DEFAULTS[k]);
      return out;
    };

    // slider 拖动时每个刻度都会触发 onChange，用 rAF 合并成一帧一次重建；
    // 预设级联写回期间（cascading）暂停重建，结束时加过渡禁用护罩后整体重算一次，
    // 避免连环全量样式重算 + 全站同时跑颜色过渡导致掉帧与窗口闪烁
    let rafId = 0;
    let cascading = 0;
    let guardArmed = false;
    let lastCss = '';
    const apply = () => {
      const css = buildCss(current());
      if (css === lastCss) return;
      lastCss = css;
      u.injectStyle('theme-workshop', css);
    };
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (cascading > 0) return;
        apply();
        if (guardArmed) {
          guardArmed = false;
          document.documentElement.removeAttribute('data-zmod-tw-cascade');
        }
      });
    };
    const applyPresetSnapshot = async (key) => {
      const snapshot = PRESETS[key];
      if (!snapshot) return false;
      cascading += 1;
      try {
        for (const k of ALL_KEYS) {
          if (s.get(k, DEFAULTS[k]) === snapshot[k]) continue;
          await s.set(k, snapshot[k]);
        }
      } finally {
        cascading -= 1;
      }
      if (cascading === 0) {
        guardArmed = true;
        document.documentElement.setAttribute('data-zmod-tw-cascade', '1');
        schedule();
      }
      return true;
    };

    // 材质语义：
    // - 宿主出厂在 win32 就是 acrylic + #00000000，选 acrylic 无可见变化属正常；
    // - 「不修改」在本会话动过材质后要恢复出厂参数（RPC 的 'none' 会重置成不透明白底，不能用）；
    // - 壁纸层/全不透明分区会把底材完全盖住——主动提示用户如何让材质可见。
    let materialTouched = false;
    const applyMaterial = async (v, { verbose = false } = {}) => {
      if (v === 'keep') {
        if (!materialTouched) return;
        materialTouched = false;
        try {
          await invoke('window.setMaterial', { material: 'acrylic', tint: '#00000000' });
          if (verbose) u.showToast('已恢复系统默认材质（亚克力）', 'info');
        } catch (err) {
          console.error('[ZMod:ThemeWorkshop] restore material failed:', err?.message || err);
        }
        return;
      }
      if (v !== 'acrylic' && v !== 'mica') return;
      materialTouched = true;
      try {
        const res = await invoke('window.setMaterial', { material: v, tint: '#00000000' });
        if (res && res.supported === false) {
          u.showToast('当前系统不支持该窗口材质，已保持不透明', 'warn');
          return;
        }
        if (verbose) {
          const wpMode = s.get('wallpaperMode', DEFAULTS.wallpaperMode);
          const opBg = Number(s.get('opBackground', DEFAULTS.opBackground)) || 0;
          if (wpMode !== 'none') {
            u.showToast('材质已设置，但当前「壁纸层」盖在窗口底材之上——想看见效果，请把「壁纸来源」改为「关闭壁纸」并调低主背景透明度', 'warn');
          } else if (opBg >= 95) {
            u.showToast('材质已设置，但「主背景」接近全不透明——把它的数值调低（如 70）即可透出桌面', 'info');
          } else {
            u.showToast(v === 'mica' ? '窗口材质已切换为云母' : '窗口材质已切换为亚克力', 'success');
          }
        }
      } catch (err) {
        console.error('[ZMod:ThemeWorkshop] setMaterial failed:', err?.message || err);
        if (verbose) u.showToast('窗口材质设置失败', 'error');
      }
    };

    // 仅 custom 模式下探测壁纸文件是否可访问，失败只提醒、绝不影响主流程
    const checkWallpaperFile = async () => {
      try {
        if (s.get('wallpaperMode', DEFAULTS.wallpaperMode) !== 'custom') return;
        const file = String(s.get('wallpaperFile', '') || '').trim();
        if (!file) return;
        const url = `zmod-local://plugins/theme-workshop/wallpapers/${encodeURIComponent(file)}`;
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) {
          u.showToast(`未找到壁纸文件，请确认已放入 ${WALLPAPER_PATH_HINT} 且文件名填写正确`, 'warn');
        }
      } catch (err) {
        console.warn('[ZMod:ThemeWorkshop] wallpaper check skipped:', err?.message || err);
      }
    };

    apply();
    ctx.cleanup(() => {
      u.removeStyle('theme-workshop');
      document.documentElement.removeAttribute('data-zmod-tw-cascade');
    });

    for (const k of ALL_KEYS) {
      s.onChange(k, () => schedule());
    }
    // 预设键额外级联：选中快照即原子套用（级联期间暂停逐帧重建，结束一次重算）
    s.onChange('preset', (v) => {
      applyPresetSnapshot(v);
    });
    s.onChange('material', (v) => applyMaterial(v, { verbose: true }));
    s.onChange('wallpaperMode', () => checkWallpaperFile());
    s.onChange('wallpaperFile', () => checkWallpaperFile());

    const initialMaterial = s.get('material', DEFAULTS.material);
    if (initialMaterial !== 'keep') await applyMaterial(initialMaterial);
    checkWallpaperFile();
  },

  async stop() {
    /* teardown handled via ctx.cleanup */
  }
});
