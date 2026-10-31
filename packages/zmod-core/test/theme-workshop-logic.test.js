import test from 'node:test';
import assert from 'node:assert/strict';

const {
  DEFAULTS,
  ALL_KEYS,
  PRESETS,
  BUILTIN_WALLPAPERS,
  buildCss,
  resolveWallpaperUrl,
  sanitizeFontName
} = await import('../../../plugins/theme-workshop/lib.js');

function assertBalancedBraces(css) {
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  assert.equal(open, close, `花括号不配平: { ${open} vs } ${close}`);
  assert.ok(open > 0, 'CSS 不应没有任何规则块');
}

// 1. 每个预设快照覆盖全部设置键
test('PRESETS: 每个快照键集合 === ALL_KEYS', () => {
  for (const [name, snapshot] of Object.entries(PRESETS)) {
    assert.deepEqual(
      Object.keys(snapshot).sort(),
      [...ALL_KEYS].sort(),
      `预设 ${name} 键集合与 ALL_KEYS 不一致`
    );
  }
});

// 2. 基本卫生：字符串、无 undefined/NaN/null、括号配平
test('buildCss: DEFAULTS 与全部预设输出合法 CSS', () => {
  const cases = [DEFAULTS, ...Object.values(PRESETS)];
  for (const [i, s] of cases.entries()) {
    const css = buildCss(s);
    assert.equal(typeof css, 'string', `case ${i} 应返回字符串`);
    assert.ok(css.length > 100);
    assert.ok(!css.includes('undefined'), `case ${i} 含 undefined`);
    assert.ok(!css.includes('NaN'), `case ${i} 含 NaN`);
    assert.ok(!css.includes('null'), `case ${i} 含 null`);
    assertBalancedBraces(css);
  }
});

// 3. 全不透明时 dark 主背景为原始色的 100% color-mix
test('buildCss: op 全 100 → color-mix 100%', () => {
  const css = buildCss({ ...DEFAULTS, opBackground: 100, opSidebar: 100, opHeader: 100, opPanel: 100, opCard: 100, opInput: 100, opMenu: 100, opBubble: 100, opTerminal: 100, opCode: 100 });
  assert.ok(css.includes('color-mix(in srgb, #161616 100%, transparent)'));
});

// 4. 消息气泡 alpha 换算
test('buildCss: opBubble=50 → dark 0.04 / light 0.025', () => {
  const css = buildCss({ ...DEFAULTS, opBubble: 50 });
  assert.ok(css.includes('rgba(255,255,255,0.04)'), 'dark 组气泡 alpha');
  assert.ok(css.includes('rgba(13,13,13,0.025)'), 'light 组气泡 alpha');
});

// 5. 圆角：6=官方默认（无强制覆盖），12 输出 !important 覆盖
test('buildCss: radius 6 vs 12', () => {
  const def = buildCss({ ...DEFAULTS, radius: 6 });
  assert.ok(def.includes('--radius-md: 6px'));
  assert.ok(!def.includes('border-radius: 6px !important'), '默认圆角不应输出强制覆盖');
  const big = buildCss({ ...DEFAULTS, radius: 12 });
  assert.ok(big.includes('border-radius: 12px !important'));
  assert.ok(big.includes('--radius-md: 12px'));
});

// 6. 字体名净化：截断 CSS 注入企图
test('sanitizeFontName/buildCss: 恶意字体名被净化', () => {
  const evil = 'Evil"; } html{display:none';
  const css = buildCss({ ...DEFAULTS, fontUi: evil });
  assert.ok(!css.includes('; }'), '输出不得含 ; }');
  assert.ok(css.includes('"Evil"'), `净化后的名字应为 Evil，实际输出片段: ${css.slice(-400)}`);
  assert.equal(sanitizeFontName(evil), 'Evil');
  assert.equal(sanitizeFontName('Microsoft YaHei'), 'Microsoft YaHei');
  assert.equal(sanitizeFontName(''), '');
});

// 7. 自定义壁纸 URL 与关闭壁纸
test('buildCss: custom 壁纸 URL 编码 / none 不出壁纸层', () => {
  const file = '我的 壁纸.PNG';
  const css = buildCss({ ...DEFAULTS, wallpaperMode: 'custom', wallpaperFile: file });
  assert.ok(css.includes('zmod-local://plugins/theme-workshop/wallpapers/'));
  assert.ok(css.includes(encodeURIComponent(file)));
  assert.ok(css.includes('background-size: cover;'));
  const off = buildCss({ ...DEFAULTS, wallpaperMode: 'none' });
  assert.ok(!off.includes('html::before'));
});

// 8. 暗角开关
test('buildCss: vignette 0 vs 40', () => {
  const off = buildCss({ ...DEFAULTS, wallpaperVignette: 0 });
  assert.ok(!off.includes('html::after'));
  const on = buildCss({ ...DEFAULTS, wallpaperVignette: 40 });
  assert.ok(on.includes('rgba(0, 0, 0, 0.4)'));
});

// 9. 越界值 clamp
test('buildCss: 越界数值按边界处理', () => {
  const css = buildCss({ ...DEFAULTS, opBackground: 999, wallpaperBlur: -5 });
  assert.ok(css.includes('color-mix(in srgb, #161616 100%, transparent)'), 'opBackground 999 → 100');
  assert.ok(css.includes('blur(0px)'), 'wallpaperBlur -5 → 0');
  assert.ok(!css.includes('999'), '不得出现未 clamp 的值');
});

// 10. resolveWallpaperUrl 分支
test('resolveWallpaperUrl: builtin/custom/非法输入', () => {
  const builtin = resolveWallpaperUrl('builtin', 'aurora', '');
  assert.ok(builtin && typeof builtin.gradient === 'string');
  assert.ok(BUILTIN_WALLPAPERS.aurora.css === builtin.gradient);
  assert.equal(resolveWallpaperUrl('builtin', 'ghost', ''), null);
  assert.equal(resolveWallpaperUrl('custom', '', '   '), null);
  const custom = resolveWallpaperUrl('custom', '', ' my.png ');
  assert.deepEqual(custom, {
    url: 'zmod-local://plugins/theme-workshop/wallpapers/' + encodeURIComponent('my.png')
  });
  assert.equal(resolveWallpaperUrl('none', 'aurora', ''), null);
});
