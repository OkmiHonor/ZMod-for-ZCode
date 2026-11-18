import test from 'node:test';
import assert from 'node:assert/strict';

const {
  matchInstance, matchSelection, parseModelButtonLabel, selectMagpieBuckets,
  scrollWrap, applyCardPrefs, parseCardPrefs
} = await import('../../../plugins/quota-popover/lib.js');

// instance shapes mirror autodetectDatasources proposals (real-world names &
// keyword sets the plugin meets in production)
const deepseekInst = {
  id: 'deepseek',
  type: 'deepseek',
  name: 'DeepSeek 官方余额',
  settings: { modelKeywords: 'deepseek' }
};
const bailianInst = {
  id: 'bailian-bss',
  type: 'bailian-bss',
  name: '阿里云百炼资金账户',
  settings: { modelKeywords: 'qwen, 百炼, bailian' }
};
const antigravityInst = {
  id: 'antigravity',
  type: 'antigravity',
  name: 'Antigravity 网关',
  settings: { url: 'http://127.0.0.1:8045', modelKeywords: 'gemini, claude, gpt, antigravity' }
};

const snapOf = (order, extra = {}) =>
  order.map((inst) => ({ inst, status: { ok: true, ...extra } }));

test('parseModelButtonLabel: 供应商/模型 effort 形态剥离五形态后缀', () => {
  assert.deepEqual(parseModelButtonLabel('百炼/DeepSeek-V3 极高'), { provider: '百炼', model: 'DeepSeek-V3' });
  assert.deepEqual(parseModelButtonLabel('百炼/DeepSeek-V3 低'), { provider: '百炼', model: 'DeepSeek-V3' });
  assert.deepEqual(parseModelButtonLabel('Antigravity/gemini-3.8-flash 最高'), {
    provider: 'Antigravity',
    model: 'gemini-3.8-flash'
  });
  assert.deepEqual(parseModelButtonLabel('百炼/qwen-max 关闭'), { provider: '百炼', model: 'qwen-max' });
});

test('parseModelButtonLabel: 无前缀预设只有模型名 + effort', () => {
  assert.deepEqual(parseModelButtonLabel('GLM-5.3-Flash 低'), { provider: '', model: 'GLM-5.3-Flash' });
  assert.deepEqual(parseModelButtonLabel('GLM-5.3-Flash 中'), { provider: '', model: 'GLM-5.3-Flash' });
});

test('parseModelButtonLabel: 容量 gauge 与工具按钮标签不解析为模型选择', () => {
  assert.equal(parseModelButtonLabel('上下文已用 12,345 / 总量 200,000'), null);
  assert.equal(parseModelButtonLabel('添加上下文'), null);
  assert.equal(parseModelButtonLabel('切换模式'), null);
  assert.equal(parseModelButtonLabel('电脑操作'), null);
  assert.equal(parseModelButtonLabel('发送'), null);
  assert.equal(parseModelButtonLabel(''), null);
});

test('回归：百炼订阅源选 deepseek 模型 → 匹配百炼实例，而非 deepseek 实例', () => {
  // bug 场景：deepseek 实例排在前面、其关键字 "deepseek" 命中模型名——
  // 修复前全局关键字链把它抢走，浮窗显示 DeepSeek 账户余额
  const snapshot = snapOf([deepseekInst, bailianInst]);
  const sel = parseModelButtonLabel('百炼/DeepSeek-V3 极高');
  assert.deepEqual(matchSelection(sel, snapshot), bailianInst);
  // 即使百炼实例没有任何 modelKeywords，供应商段与实例名包含关系也要兜住
  const bailianNoKw = { id: 'bailian-bss', type: 'bailian-bss', name: '阿里云百炼资金账户', settings: {} };
  assert.deepEqual(
    matchSelection(sel, snapOf([deepseekInst, bailianNoKw])),
    bailianNoKw
  );
});

test('回归：有供应商前缀但没有任何实例跟随该订阅源 → 不匹配（不注入）', () => {
  // 修复前会退回模型名链：只有 deepseek 实例时 "百炼/DeepSeek-V3" 错配 deepseek
  const snapshot = snapOf([deepseekInst]);
  assert.equal(matchSelection({ provider: '百炼', model: 'DeepSeek-V3' }, snapshot), null);
  assert.equal(matchSelection({ provider: '未知源', model: 'whatever' }, snapOf([deepseekInst, bailianInst])), null);
});

test('订阅源前缀按关键字或名称命中对应实例', () => {
  const snapshot = snapOf([bailianInst, deepseekInst, antigravityInst]);
  assert.deepEqual(matchSelection({ provider: '百炼', model: 'qwen-max' }, snapshot), bailianInst);
  assert.deepEqual(matchSelection({ provider: 'DeepSeek', model: 'deepseek-chat' }, snapshot), deepseekInst);
  assert.deepEqual(matchSelection({ provider: 'Antigravity', model: 'gemini-3.8-flash' }, snapshot), antigravityInst);
});

test('Google 与 Google AI Pro 供应商前缀命中 Antigravity 网关实例', () => {
  const snapshot = snapOf([bailianInst, deepseekInst, antigravityInst]);
  assert.deepEqual(
    matchSelection(parseModelButtonLabel('Google AI Pro/gemini-3.8-flash 极高'), snapshot),
    antigravityInst
  );
  assert.deepEqual(
    matchSelection(parseModelButtonLabel('Google AI Pro/claude-sonnet-5-5 极高'), snapshot),
    antigravityInst
  );
  assert.deepEqual(
    matchSelection(parseModelButtonLabel('Google/gemini-4-argon'), snapshot),
    antigravityInst
  );
});

test('无前缀 GLM 预设：原模型名匹配链不变', () => {
  // 关键字链：模型名命中某实例关键字
  const mimoInst = { id: 'mimo', type: 'mimo', name: '小米 MiMo', settings: { modelKeywords: 'mimo' } };
  assert.deepEqual(
    matchSelection({ provider: '', model: 'MiMo-V2' }, snapOf([bailianInst, mimoInst])),
    mimoInst
  );
  // 关键字都不命中时落到 antigravity status.models 双向前缀匹配：
  // 网关注册变体名，工具栏显示基础名
  const antigravNoKw = {
    id: 'antigravity',
    type: 'antigravity',
    name: 'Antigravity 网关',
    settings: { url: 'http://127.0.0.1:8045' }
  };
  const snapshot = [
    { inst: bailianInst, status: { ok: true } },
    {
      inst: antigravNoKw,
      status: { ok: true, models: [{ name: 'gemini-3.8-flash-low' }] }
    }
  ];
  assert.deepEqual(
    matchSelection({ provider: '', model: 'gemini-3.8-flash' }, snapshot),
    antigravNoKw
  );
  // models 精确匹配
  assert.deepEqual(
    matchSelection({ provider: '', model: 'gemini-3.8-flash-low' }, snapshot),
    antigravNoKw
  );
});

test('无前缀且无任何命中 → 不匹配（不注入）', () => {
  const snapshot = snapOf([bailianInst, deepseekInst]);
  assert.equal(matchSelection({ provider: '', model: 'totally-unknown-model' }, snapshot), null);
  assert.equal(matchSelection(null, snapshot), null);
});

test('Surface 2 matchInstance 保持原语义：host 优先、名称重叠 ≥4', () => {
  const instances = [
    { id: 'bailian-bss', name: '阿里云百炼资金账户', settings: { url: 'https://bailian.aliyun.com' } },
    { id: 'deepseek', name: 'DeepSeek 官方余额', settings: {} }
  ];
  assert.deepEqual(
    matchInstance('任意名', 'https://bailian.aliyun.com:443/v1', instances),
    instances[0]
  );
  assert.deepEqual(matchInstance('DeepSeek 官方', '', instances), instances[1]);
  // 名称过短（<4）不做模糊匹配
  assert.equal(matchInstance('百炼', '', instances), null);
});

test('parseModelButtonLabel: 多斜杠模型标签按首个斜杠拆分 provider 与 model', () => {
  assert.deepEqual(
    parseModelButtonLabel('magpie/zcode/GLM-5.3-Flash 高'),
    { provider: 'magpie', model: 'zcode/GLM-5.3-Flash' }
  );
  assert.deepEqual(
    parseModelButtonLabel('硅基流动/deepseek-ai/DeepSeek-V4-Flash 极高'),
    { provider: '硅基流动', model: 'deepseek-ai/DeepSeek-V4-Flash' }
  );
});

test('Surface 2 matchInstance: HOST_TYPE_RULES 识别官方 API 域名并映射到对应实例 type', () => {
  const instances = [
    { id: 'bailian-bss', type: 'bailian-bss', name: '阿里云', settings: {} },
    { id: 'siliconflow', type: 'siliconflow', name: '硅基流动余额', settings: {} },
    { id: 'openrouter', type: 'openrouter', name: 'OpenRouter', settings: {} }
  ];
  assert.deepEqual(
    matchInstance('阿里云百炼（中国）', 'https://dashscope.aliyuncs.com/compatible-mode/v1', instances),
    instances[0]
  );
  assert.deepEqual(
    matchInstance('SiliconFlow', 'https://api.siliconflow.cn/v1', instances),
    instances[1]
  );
  assert.deepEqual(
    matchInstance('OR', 'https://openrouter.ai/api/v1', instances),
    instances[2]
  );
});

test('Surface 1 matchSelection: 结合 providerCatalog 通过 baseUrl host 匹配自定义命名反代网关', () => {
  const proxyInst = {
    id: 'newapi-1',
    type: 'newapi',
    name: 'NewAPI 网关',
    settings: { baseUrl: 'https://relay.myproxy.org/v1' }
  };
  const snapshot = snapOf([deepseekInst, proxyInst]);
  const catalog = [
    { id: 'custom-1', name: '主力中转站', baseUrl: 'https://relay.myproxy.org/v1', enabled: true }
  ];
  const sel = parseModelButtonLabel('主力中转站/claude-sonnet-4-5 高');
  assert.deepEqual(matchSelection(sel, snapshot, catalog), proxyInst);
});


test('selectMagpieBuckets: 词边界精确匹配，GLM-5.3 不吸 GLM-5.3-Flash 的桶', () => {
  const groups = [
    { name: 'ZCode', buckets: [
      { window: 'GLM-5.3', frac: 0.9 },
      { window: 'GLM-5.3-Flash', frac: 0.544 }
    ] },
    { name: 'WorkBuddy', buckets: [{ window: 'Credits', frac: 0.927 }] },
    { name: 'Antigravity', buckets: [{ window: 'Gemini · 5 hours', frac: 0.842 }] }
  ];
  const flash = selectMagpieBuckets('zcode/GLM-5.3-Flash', groups);
  assert.equal(flash.length, 1, 'Flash 只命中自己的桶');
  assert.equal(flash[0].group.name, 'ZCode');
  assert.equal(flash[0].bucket.frac, 0.544);
  const m53 = selectMagpieBuckets('GLM-5.3', groups);
  assert.equal(m53.length, 1);
  assert.equal(m53[0].bucket.window, 'GLM-5.3');
});

test('selectMagpieBuckets: 模型族兜底与 null 兜底', () => {
  const groups = [
    { name: 'Antigravity', buckets: [
      { window: 'Gemini · 5 hours', frac: 0.842 },
      { window: 'Claude & GPT · 5 hours', frac: 0.481 }
    ] },
    { name: 'WorkBuddy', buckets: [{ window: 'deepseek-v4.1', frac: 0.906 }] }
  ];
  const gem = selectMagpieBuckets('antigravity/gemini-3.8-flash', groups);
  assert.equal(gem.length, 1, 'gemini 模型族兜底命中 Gemini 池');
  assert.equal(gem[0].bucket.window, 'Gemini · 5 hours');
  const ds = selectMagpieBuckets('deepseek-v4-pro', groups);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].group.name, 'WorkBuddy');
  const claude = selectMagpieBuckets('claude-sonnet-5-5', groups);
  assert.equal(claude.length, 1);
  assert.equal(claude[0].bucket.window, 'Claude & GPT · 5 hours');
  assert.equal(selectMagpieBuckets('some-unknown-model', groups), null, '认不出的模型族 → null（调用方退回全量）');
  assert.equal(selectMagpieBuckets('', groups), null);
  assert.equal(selectMagpieBuckets('GLM-5.3-Flash', null), null, 'groups 非数组 → null');
});

/* ============ scrollWrap：卡片主体滚动容器 ============ */

test('scrollWrap: enabled=false 逐字节原样返回，零包裹', () => {
  const html = '<div class="card">余额 100</div>';
  assert.equal(scrollWrap(html, { enabled: false }), html);
  assert.equal(scrollWrap(html, { enabled: false, maxHeight: 200 }), html);
  assert.equal(scrollWrap(html), html, 'opts 缺省不包裹');
  assert.equal(scrollWrap(html, { scope: 'none' }), html, '仅 scope 不算开启');
});

test('scrollWrap: enabled=true 包裹带 overflow-y / overscroll / zmod-qp-scroll 类', () => {
  const out = scrollWrap('<b>x</b>', { enabled: true, maxHeight: 320 });
  assert.match(out, /class="zmod-qp-scroll"/);
  assert.match(out, /overflow-y:auto/);
  assert.match(out, /overscroll-behavior:contain/);
  assert.match(out, /max-height:320px/);
  assert.match(out, /<b>x<\/b>/);
  assert.ok(!out.includes('pointer-events:none'), '不能吞掉 hover-card 的指针事件');
});

test('scrollWrap: maxHeight clamp 到 [120,800] 整数，非法值回退 320', () => {
  const mh = (v) => {
    const m = /max-height:(\d+)px/.exec(scrollWrap('x', { enabled: true, maxHeight: v }));
    return m ? Number(m[1]) : null;
  };
  assert.equal(mh(0), 120, '0 → 下界 120');
  assert.equal(mh(-50), 120);
  assert.equal(mh(2000), 800, '2000 → 上界 800');
  assert.equal(mh(NaN), 320, 'NaN → 320');
  assert.equal(mh('abc'), 320, "'abc' → 320");
  assert.equal(mh(undefined), 320);
  assert.equal(mh(255.6), 256, '小数四舍五入为整数');
  assert.equal(mh(150), 150);
});

test('scrollWrap: innerHtml 为空/非字符串 → 按空串处理', () => {
  const empty = scrollWrap('', { enabled: true });
  assert.match(empty, /class="zmod-qp-scroll"/);
  assert.match(empty, /><\/div>/, '容器里没有内容');
  assert.equal(scrollWrap(null, { enabled: true }), empty);
  assert.equal(scrollWrap(undefined, { enabled: true }), empty);
  assert.equal(scrollWrap(123, { enabled: true }), empty);
  assert.equal(scrollWrap(null, { enabled: false }), '', '未开启时也返回空串');
});

/* ============ applyCardPrefs：排序 / 显隐 / 文本映射 ============ */

const sampleCards = () => [
  { key: 'balance.topup', label: '充值余额', html: '<div>A</div>' },
  { key: 'balance.gift', label: '赠送余额', html: '<div>B</div>' },
  { key: 'quota.frac', label: '代金券', html: '<div>C</div>' }
];
const keysOf = (arr) => arr.map((c) => c.key);

test('applyCardPrefs: default 顺序不变；非数组 → []', () => {
  assert.deepEqual(keysOf(applyCardPrefs(sampleCards(), {})), ['balance.topup', 'balance.gift', 'quota.frac']);
  assert.deepEqual(keysOf(applyCardPrefs(sampleCards(), { sortMode: 'default' })), ['balance.topup', 'balance.gift', 'quota.frac']);
  assert.deepEqual(applyCardPrefs(null), []);
  assert.deepEqual(applyCardPrefs('nope'), []);
});

test('applyCardPrefs: custom 按 order 排序，未列出的按原顺序追加在后', () => {
  const ordered = applyCardPrefs(sampleCards(), {
    sortMode: 'custom',
    order: ['quota.frac', 'balance.topup']
  });
  assert.deepEqual(keysOf(ordered), ['quota.frac', 'balance.topup', 'balance.gift']);
  assert.deepEqual(keysOf(applyCardPrefs(sampleCards(), { sortMode: 'custom', order: [] })), keysOf(sampleCards()));
  assert.deepEqual(
    keysOf(applyCardPrefs(sampleCards(), { sortMode: 'custom', order: ['not.exist'] })),
    keysOf(sampleCards())
  );
});

test('applyCardPrefs: labelAsc / labelDesc 按中文 localeCompare 排序', () => {
  assert.deepEqual(
    applyCardPrefs(sampleCards(), { sortMode: 'labelAsc' }).map((c) => c.label),
    ['充值余额', '代金券', '赠送余额']
  );
  assert.deepEqual(
    applyCardPrefs(sampleCards(), { sortMode: 'labelDesc' }).map((c) => c.label),
    ['赠送余额', '代金券', '充值余额']
  );
});

test('applyCardPrefs: hiddenKeys 剔除；全被隐藏时返回原数组不动', () => {
  assert.deepEqual(keysOf(applyCardPrefs(sampleCards(), { hiddenKeys: ['balance.topup', 'quota.frac'] })), ['balance.gift']);
  const all = sampleCards();
  const allHidden = applyCardPrefs(all, { hiddenKeys: ['balance.topup', 'balance.gift', 'quota.frac'] });
  assert.deepEqual(keysOf(allHidden), keysOf(all), '避免空白卡');
  assert.deepEqual(allHidden, all);
});

test('applyCardPrefs: customLabels 只改 label 不改 html；入参不被修改', () => {
  const input = sampleCards();
  const out = applyCardPrefs(input, {
    customLabels: { 'balance.gift': '赠款', 'quota.frac': '券' }
  });
  assert.equal(out[1].label, '赠款');
  assert.equal(out[1].html, '<div>B</div>', 'html 原样保留');
  assert.equal(out[2].label, '券');
  assert.equal(input[1].label, '赠送余额', '原入参未被改动');
  assert.equal(input[1].html, '<div>B</div>');
  assert.notStrictEqual(out, input);
});

test('applyCardPrefs: 排序用的是改名后的 label；返回新数组', () => {
  const out = applyCardPrefs(sampleCards(), {
    sortMode: 'labelAsc',
    customLabels: { 'balance.gift': '阿赠款' }
  });
  assert.equal(out[0].label, '阿赠款', '改名后参与排序，排到最前');
  const input = sampleCards();
  assert.notStrictEqual(applyCardPrefs(input, {}), input);
  assert.equal(input[0].label, '充值余额');
});

/* ============ parseCardPrefs：安全解析 ============ */

const safeDefault = () => ({ hiddenKeys: [], order: [], customLabels: {}, sortMode: 'default' });

test('parseCardPrefs: 合法 JSON 完整解析', () => {
  assert.deepEqual(parseCardPrefs(JSON.stringify({
    hiddenKeys: ['usage.calls', 'quota.frac'],
    order: ['balance.gift', 'balance.topup'],
    customLabels: { 'balance.gift': '赠款' },
    sortMode: 'labelDesc'
  })), {
    hiddenKeys: ['usage.calls', 'quota.frac'],
    order: ['balance.gift', 'balance.topup'],
    customLabels: { 'balance.gift': '赠款' },
    sortMode: 'labelDesc'
  });
  // 也支持直接传对象（调用方把三项组装后过校验）
  assert.deepEqual(parseCardPrefs({ hiddenKeys: ['x'], sortMode: 'custom' }), {
    hiddenKeys: ['x'], order: [], customLabels: {}, sortMode: 'custom'
  });
});

test('parseCardPrefs: 非法 JSON / 非对象 → 安全默认', () => {
  assert.deepEqual(parseCardPrefs('{bad json'), safeDefault());
  assert.deepEqual(parseCardPrefs('null'), safeDefault());
  assert.deepEqual(parseCardPrefs('"a string"'), safeDefault());
  assert.deepEqual(parseCardPrefs('[]'), safeDefault());
  assert.deepEqual(parseCardPrefs(undefined), safeDefault());
  assert.deepEqual(parseCardPrefs(123), safeDefault());
});

test('parseCardPrefs: sortMode 白名单校验', () => {
  assert.equal(parseCardPrefs({ sortMode: 'evil' }).sortMode, 'default');
  assert.equal(parseCardPrefs({ sortMode: 'labelAsc' }).sortMode, 'labelAsc');
  assert.equal(parseCardPrefs({ sortMode: 'custom' }).sortMode, 'custom');
  assert.equal(parseCardPrefs({ sortMode: 'labelDesc' }).sortMode, 'labelDesc');
});

test('parseCardPrefs: 原型污染键被过滤（__proto__ / constructor / prototype）', () => {
  const raw = JSON.stringify({
    hiddenKeys: ['__proto__', 'constructor', 'ok'],
    order: ['prototype', 'fine'],
    customLabels: { __proto__: 'x', constructor: 'y', prototype: 'z', normal: 'v' }
  });
  const out = parseCardPrefs(raw);
  assert.deepEqual(out.hiddenKeys, ['ok']);
  assert.deepEqual(out.order, ['fine']);
  assert.deepEqual(out.customLabels, { normal: 'v' });
  assert.equal(Object.prototype.hasOwnProperty.call(out.customLabels, '__proto__'), false);
  assert.deepEqual({}.polluted, undefined, '未污染 Object.prototype');
});

test('parseCardPrefs: 类型错乱容错（非数组 / 非字符串字典 / 混合元素）', () => {
  const out = parseCardPrefs({
    hiddenKeys: 'not-an-array',
    order: [1, null, { a: 1 }, 'valid'],
    customLabels: { good: 'ok', bad: 42, worse: null, arr: [] },
    sortMode: 5
  });
  assert.deepEqual(out.hiddenKeys, []);
  assert.deepEqual(out.order, ['valid']);
  assert.deepEqual(out.customLabels, { good: 'ok' });
  assert.equal(out.sortMode, 'default');
});

test('parseCardPrefs: 超长数组/字典被裁剪，键值限长 80/100', () => {
  const out = parseCardPrefs({
    hiddenKeys: Array.from({ length: 150 }, (_, i) => 'k' + i),
    order: ['x'.repeat(200), 'short'],
    customLabels: Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['key' + i, 'v'.repeat(200)]))
  });
  assert.equal(out.hiddenKeys.length, 100, 'hiddenKeys 上限 100');
  assert.equal(out.order[0].length, 100, '单个 key 限长 100');
  assert.equal(out.order[1], 'short');
  assert.equal(Object.keys(out.customLabels).length, 50, 'customLabels 上限 50 项');
  for (const v of Object.values(out.customLabels)) assert.equal(v.length, 80, 'value 限长 80');
});

