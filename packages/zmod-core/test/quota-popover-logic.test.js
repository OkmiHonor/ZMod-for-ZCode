import test from 'node:test';
import assert from 'node:assert/strict';

const { matchInstance, matchSelection, parseModelButtonLabel } =
  await import('../../../plugins/quota-popover/lib.js');

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
