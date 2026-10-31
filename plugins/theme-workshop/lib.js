/**
 * theme-workshop 纯函数库：零 SDK 导入、零 DOM 访问，Node 可直接 import。
 * 所有 CSS 生成逻辑集中在此，index.js 只负责订阅与注入。
 */

export const DEFAULTS = {
  preset: 'frost',
  wallpaperMode: 'builtin', // none | builtin | custom
  builtinWallpaper: 'aurora', // aurora | sunset | cyber | forest
  wallpaperFile: '',
  wallpaperFit: 'cover', // cover | contain | repeat
  wallpaperBrightness: 100, // 20..100 %
  wallpaperBlur: 0, // 0..40 px
  wallpaperVignette: 30, // 0..80 %
  panelFrost: 0, // 0..30 px，0=关闭
  opBackground: 70,
  opSidebar: 55,
  opHeader: 62,
  opPanel: 66,
  opCard: 85,
  opInput: 78,
  opMenu: 92,
  opBubble: 55,
  opTerminal: 82,
  opCode: 85,
  radius: 6, // 0..24 px，6=官方默认
  fontSize: 14, // 12..18 px
  fontUi: '',
  fontMono: '',
  material: 'keep' // keep | acrylic | mica
};

export const ALL_KEYS = Object.keys(DEFAULTS);

const PRESET_LABELS = {
  vanilla: '一键还原原版',
  frost: '极简毛玻璃',
  warm: '护眼暖阳',
  cyber: '赛博流光'
};

/** 四套预设快照，每套覆盖 ALL_KEYS 全部键。 */
export const PRESETS = {
  vanilla: {
    ...DEFAULTS,
    preset: 'vanilla',
    wallpaperMode: 'none',
    panelFrost: 0,
    opBackground: 100,
    opSidebar: 100,
    opHeader: 100,
    opPanel: 100,
    opCard: 100,
    opInput: 100,
    opMenu: 100,
    opBubble: 100,
    opTerminal: 100,
    opCode: 100,
    radius: 6,
    fontSize: 14,
    fontUi: '',
    fontMono: '',
    material: 'keep'
  },
  frost: {
    ...DEFAULTS,
    preset: 'frost',
    builtinWallpaper: 'aurora',
    wallpaperVignette: 30,
    panelFrost: 14,
    opBackground: 70,
    opSidebar: 55,
    opHeader: 62,
    opPanel: 66,
    opCard: 85,
    opInput: 78,
    opMenu: 92,
    opBubble: 55,
    opTerminal: 82,
    opCode: 85,
    radius: 8
  },
  warm: {
    ...DEFAULTS,
    preset: 'warm',
    builtinWallpaper: 'sunset',
    wallpaperBrightness: 95,
    wallpaperVignette: 20,
    panelFrost: 6,
    opBackground: 82,
    opSidebar: 72,
    opHeader: 75,
    opPanel: 78,
    opCard: 88,
    opInput: 85,
    opMenu: 94,
    opBubble: 60,
    opTerminal: 88,
    opCode: 90,
    radius: 10
  },
  cyber: {
    ...DEFAULTS,
    preset: 'cyber',
    builtinWallpaper: 'cyber',
    wallpaperVignette: 45,
    panelFrost: 16,
    opBackground: 62,
    opSidebar: 50,
    opHeader: 58,
    opPanel: 60,
    opCard: 78,
    opInput: 72,
    opMenu: 90,
    opBubble: 50,
    opTerminal: 78,
    opCode: 80,
    radius: 12
  }
};

export const BUILTIN_WALLPAPERS = {
  aurora: {
    label: '晨雾青灰',
    css: 'radial-gradient(ellipse 90% 70% at 20% 15%, #dce9e7 0%, transparent 60%), radial-gradient(ellipse 80% 60% at 80% 25%, #c8d8d4 0%, transparent 55%), radial-gradient(ellipse 100% 80% at 50% 95%, #aebfc4 0%, transparent 65%), linear-gradient(160deg, #e8efee 0%, #cfdad9 45%, #b4c3c6 100%)'
  },
  sunset: {
    label: '暖阳杏橘',
    css: 'radial-gradient(ellipse 85% 65% at 75% 20%, #fbe9cf 0%, transparent 60%), radial-gradient(ellipse 75% 55% at 15% 30%, #f7e8d0 0%, transparent 55%), radial-gradient(ellipse 95% 75% at 50% 100%, #e8a87c 0%, transparent 65%), linear-gradient(165deg, #f7e8d0 0%, #f3cfa5 50%, #e8a87c 100%)'
  },
  cyber: {
    label: '深空紫蓝',
    css: 'radial-gradient(ellipse 70% 55% at 80% 15%, rgba(63, 81, 181, 0.45) 0%, transparent 60%), radial-gradient(ellipse 85% 65% at 15% 80%, #3b2f63 0%, transparent 60%), radial-gradient(ellipse 60% 45% at 55% 45%, #2a2450 0%, transparent 55%), linear-gradient(155deg, #0f1020 0%, #1c1b3a 55%, #3b2f63 100%)'
  },
  forest: {
    label: '松林墨绿',
    css: 'radial-gradient(ellipse 80% 60% at 25% 20%, #2e4438 0%, transparent 60%), radial-gradient(ellipse 75% 55% at 80% 35%, #22352b 0%, transparent 55%), radial-gradient(ellipse 95% 70% at 50% 100%, #16241d 0%, transparent 65%), linear-gradient(160deg, #24382e 0%, #1a2a22 55%, #12201a 100%)'
  }
};

const OP_KEYS = [
  'opBackground',
  'opSidebar',
  'opHeader',
  'opPanel',
  'opCard',
  'opInput',
  'opMenu',
  'opBubble',
  'opTerminal',
  'opCode'
];

const WALLPAPER_MODES = new Set(['none', 'builtin', 'custom']);
const WALLPAPER_FITS = new Set(['cover', 'contain', 'repeat']);

/** 数值清洗：非法回退 fallback，合法则 clamp 到 [min, max] 并取整。 */
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function str(v, fallback) {
  return typeof v === 'string' ? v : fallback;
}

/** 去掉数字尾部多余的 0（0.0400 → "0.04"，6.00 → "6"）。 */
function fmt(n) {
  return String(Number(n.toFixed(4)));
}

/**
 * 字体名净化：在第一个引号/分号/花括号/反斜杠/换行处截断，
 * 防止用户输入逃出 CSS 字符串上下文。
 */
export function sanitizeFontName(name) {
  const raw = String(name ?? '');
  const parts = raw.split(/["';{}\\\r\n]/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** 解析壁纸来源：builtin → 渐变值；custom → zmod-local URL；否则 null。 */
export function resolveWallpaperUrl(mode, builtinId, file) {
  if (mode === 'builtin') {
    const wp = BUILTIN_WALLPAPERS[builtinId];
    return wp ? { gradient: wp.css } : null;
  }
  if (mode === 'custom') {
    const name = String(file ?? '').trim();
    if (!name) return null;
    return { url: 'zmod-local://plugins/theme-workshop/wallpapers/' + encodeURIComponent(name) };
  }
  return null;
}

function opacityBlock(selector, entries) {
  const lines = entries.map(([key, value]) => `  ${key}: ${value};`).join('\n');
  return `${selector} {\n${lines}\n}`;
}

/**
 * 由设置对象生成完整皮肤 CSS。
 * 数值一律先 clamp；壁纸来源解析失败时跳过壁纸层。
 */
export function buildCss(s) {
  const src = s && typeof s === 'object' ? s : {};

  const mode = WALLPAPER_MODES.has(src.wallpaperMode) ? src.wallpaperMode : DEFAULTS.wallpaperMode;
  const builtinId = str(src.builtinWallpaper, DEFAULTS.builtinWallpaper);
  const file = str(src.wallpaperFile, DEFAULTS.wallpaperFile);
  const fit = WALLPAPER_FITS.has(src.wallpaperFit) ? src.wallpaperFit : DEFAULTS.wallpaperFit;

  const brightness = clampNum(src.wallpaperBrightness, 20, 100, DEFAULTS.wallpaperBrightness);
  const blur = clampNum(src.wallpaperBlur, 0, 40, DEFAULTS.wallpaperBlur);
  const vignette = clampNum(src.wallpaperVignette, 0, 80, DEFAULTS.wallpaperVignette);
  const frost = clampNum(src.panelFrost, 0, 30, DEFAULTS.panelFrost);
  const radius = clampNum(src.radius, 0, 24, DEFAULTS.radius);
  const fontSize = clampNum(src.fontSize, 12, 18, DEFAULTS.fontSize);

  const op = {};
  for (const k of OP_KEYS) {
    op[k] = clampNum(src[k], 0, 100, DEFAULTS[k]);
  }

  const blocks = [];

  // A. 壁纸层 + 暗角
  const wp = resolveWallpaperUrl(mode, builtinId, file);
  if (wp) {
    const bgLines = [];
    if (wp.gradient !== undefined) {
      bgLines.push(`  background: ${wp.gradient};`);
    } else {
      bgLines.push(`  background: url("${wp.url}");`);
      if (fit === 'repeat') {
        bgLines.push('  background-size: auto;');
        bgLines.push('  background-position: center;');
        bgLines.push('  background-repeat: repeat;');
      } else {
        bgLines.push(`  background-size: ${fit};`);
        bgLines.push('  background-position: center;');
        bgLines.push('  background-repeat: no-repeat;');
      }
    }
    const filter = `filter: brightness(${fmt(brightness / 100)}) blur(${fmt(blur)}px);`;
    blocks.push(
      `html::before {\n  content: "";\n  position: fixed;\n  inset: -24px;\n  z-index: -2;\n${bgLines.join('\n')}\n  ${filter}\n}`
    );
    if (vignette > 0) {
      blocks.push(
        `html::after {\n  content: "";\n  position: fixed;\n  inset: 0;\n  z-index: -1;\n  pointer-events: none;\n  background: radial-gradient(ellipse at center, transparent 45%, rgba(0, 0, 0, ${fmt(vignette / 100)}) 100%);\n}`
      );
    }
  }

  // B. 分区透明度：官方 token 全为完整颜色值，用 color-mix 做透明化
  const mix = (hex, percent) => `color-mix(in srgb, ${hex} ${percent}%, transparent)`;

  const darkEntries = [
    ['--color-background', mix('#161616', op.opBackground)],
    ['--color-background-win-alt', mix('#2b2b2b', Math.min(100, op.opBackground + 10))],
    [
      '--color-background-alt',
      `rgba(38,38,38,${fmt(0.6 * (op.opBackground / 100))})`
    ],
    ['--color-sidebar', mix('#161616', op.opSidebar)],
    ['--color-header', mix('#202020', op.opHeader)],
    ['--color-tab', mix('#202020', op.opHeader)],
    ['--color-tab-active', mix('#161616', op.opHeader)],
    ['--color-panel', mix('#202020', op.opPanel)],
    ['--color-card', mix('#2b2b2b', op.opCard)],
    ['--color-card-selected', mix('#2b2b2b', op.opCard)],
    ['--color-input', mix('#2b2b2b', op.opInput)],
    ['--color-input-focused', mix('#161616', op.opInput)],
    ['--color-popover', mix('#2b2b2b', op.opMenu)],
    ['--color-popover-header', mix('#202020', op.opMenu)],
    ['--color-menu', mix('#2b2b2b', op.opMenu)],
    ['--color-menu-hover', mix('#363636', op.opMenu)],
    ['--color-tooltip', mix('#2b2b2b', op.opMenu)],
    ['--color-tooltip-tag', mix('#363636', op.opMenu)],
    ['--color-toast', mix('#2b2b2b', op.opMenu)],
    [
      '--color-user-message-bubble',
      `rgba(255,255,255,${fmt(0.08 * (op.opBubble / 100))})`
    ],
    ['--color-terminal-bg', mix('#161616', op.opTerminal)],
    ['--color-markdown-inline-code', mix('#363636', op.opCode)],
    ['--shiki-dark-bg', mix('#1b1d22', op.opCode)],
    ['--sdm-tbg', mix('#1b1d22', op.opCode)]
  ];

  const lightEntries = [
    ['--color-background', mix('#f8f8f8', op.opBackground)],
    ['--color-background-win-alt', mix('#ececee', Math.min(100, op.opBackground + 10))],
    [
      '--color-background-alt',
      `rgba(245,245,245,${fmt(0.6 * (op.opBackground / 100))})`
    ],
    ['--color-sidebar', mix('#f0f0f0', op.opSidebar)],
    ['--color-header', mix('#ffffff', op.opHeader)],
    ['--color-tab', mix('#f0f0f0', op.opHeader)],
    ['--color-tab-active', mix('#ffffff', op.opHeader)],
    ['--color-panel', mix('#ffffff', op.opPanel)],
    ['--color-card', mix('#ffffff', op.opCard)],
    ['--color-card-selected', mix('#ffffff', op.opCard)],
    ['--color-input', mix('#ffffff', op.opInput)],
    ['--color-input-focused', mix('#f8f8f8', op.opInput)],
    ['--color-popover', mix('#ffffff', op.opMenu)],
    ['--color-popover-header', mix('#f8f8f8', op.opMenu)],
    ['--color-menu', mix('#ffffff', op.opMenu)],
    ['--color-menu-hover', mix('#f0f0f0', op.opMenu)],
    ['--color-tooltip', mix('#f0f0f0', op.opMenu)],
    ['--color-tooltip-tag', mix('#e6e6e6', op.opMenu)],
    ['--color-toast', mix('#ffffff', op.opMenu)],
    [
      '--color-user-message-bubble',
      `rgba(13,13,13,${fmt(0.05 * (op.opBubble / 100))})`
    ],
    ['--color-terminal-bg', mix('#f8f8f8', op.opTerminal)],
    ['--color-markdown-inline-code', mix('#e6e6e6', op.opCode)],
    ['--shiki-dark-bg', mix('#f6f6f7', op.opCode)],
    ['--sdm-tbg', mix('#f6f6f7', op.opCode)]
  ];

  blocks.push(opacityBlock('html.theme-zai-dark, html.dark', darkEntries));
  blocks.push(opacityBlock('html.theme-zai-light', lightEntries));

  // C. 圆角
  const px = (v) => `${fmt(v)}px`;
  const radiusEntries = [
    `  --radius-xs: ${px(radius / 3)};`,
    `  --radius-sm: ${px((2 * radius) / 3)};`,
    `  --radius-md: ${px(radius)};`,
    `  --radius-lg: ${px((4 * radius) / 3)};`,
    `  --radius-xl: ${px(2 * radius)};`,
    `  --radius-2xl: ${px((8 * radius) / 3)};`,
    `  --radius-3xl: ${px(4 * radius)};`
  ].join('\n');
  blocks.push(`:root {\n${radiusEntries}\n}`);
  if (radius !== 6) {
    blocks.push(
      `section[data-workspace-conversation-frame="true"],\n[data-workspace-side-frame="true"],\n[data-workspace-terminal-frame="true"] {\n  border-radius: ${fmt(radius)}px !important;\n}`
    );
  }

  // D. 字号
  if (fontSize !== 14) {
    blocks.push(`:root {\n  --ui-font-size: ${fmt(fontSize)}px;\n}`);
  }

  // E. 字体
  const uiName = sanitizeFontName(src.fontUi ?? DEFAULTS.fontUi);
  if (uiName) {
    const sans = `"${uiName}", ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"`;
    blocks.push(`:root {\n  --font-sans: ${sans};\n  --default-font-family: ${sans};\n}`);
  }
  const monoName = sanitizeFontName(src.fontMono ?? DEFAULTS.fontMono);
  if (monoName) {
    const mono = `"${monoName}", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
    blocks.push(`:root {\n  --font-mono: ${mono};\n  --default-mono-font-family: ${mono};\n}`);
  }

  // F. 面板毛玻璃
  if (frost > 0) {
    blocks.push(
      `[data-workspace-sidebar-panel="true"],\nsection[data-workspace-conversation-frame="true"],\n[data-workspace-side-frame="true"],\n[data-workspace-terminal-frame="true"] {\n  backdrop-filter: blur(${fmt(frost)}px) saturate(115%);\n}`
    );
  }

  return blocks.join('\n\n') + '\n';
}
