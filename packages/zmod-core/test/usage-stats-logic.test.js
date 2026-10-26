import test from 'node:test';
import assert from 'node:assert/strict';

const { PRICING, isPeakHour, costTable, calculateCost, pickScoped } =
  await import('../../../plugins/usage-stats/lib.js');

// 北京时间锚点（UTC 显式构造，不依赖本机时区）：
// 2026-10-26 是周一。UTC 02:00 = 北京 10:00（峰）；UTC 04:30 = 北京 12:30（谷）。
const MON_PEAK = new Date(Date.UTC(2026, 9, 26, 2, 0));   // 周一 10:00 北京
const MON_LUNCH = new Date(Date.UTC(2026, 9, 26, 4, 30)); // 周一 12:30 北京
const MON_NIGHT = new Date(Date.UTC(2026, 9, 25, 19, 0)); // 周一 03:00 北京
const SAT_PEAKISH = new Date(Date.UTC(2026, 9, 31, 2, 0)); // 周六 10:00 北京

test('isPeakHour: Beijing weekday windows and off-peak boundaries', () => {
  assert.equal(isPeakHour(MON_PEAK), true, 'Mon 10:00 Beijing = peak');
  assert.equal(isPeakHour(MON_LUNCH), false, 'Mon 12:30 Beijing = lunch break, off-peak');
  assert.equal(isPeakHour(MON_NIGHT), false, 'Mon 03:00 Beijing = off-peak');
  assert.equal(isPeakHour(SAT_PEAKISH), false, 'Sat 10:00 Beijing = weekend, off-peak');
});

test('costTable: deepseek gate and model mapping', () => {
  assert.equal(costTable('glm-4.7'), null, 'non-deepseek → null');
  assert.equal(costTable('qwen3-max'), null);
  assert.equal(costTable(''), null);
  assert.equal(costTable('DeepSeek-Flash'), PRICING.flash, 'case-insensitive gate');
  assert.equal(costTable('deepseek-v4-pro'), PRICING.v4pro);
  assert.equal(costTable('deepseek/v4pro'), PRICING.v4pro, 'v4pro separator variants');
  assert.equal(costTable('deepseek-flash'), PRICING.flash);
  assert.equal(costTable('deepseek-reasoner'), PRICING.r1legacy);
  assert.equal(costTable('deepseek-r1'), PRICING.r1legacy, 'standalone r1 → r1legacy');
  assert.equal(costTable('deepseek-chat'), PRICING.v3legacy);
  assert.equal(costTable('deepseek-v3'), PRICING.v3legacy);
  assert.equal(costTable('deepseek-something-new'), PRICING.flash, 'unknown deepseek variant → flash default');
  assert.equal(costTable('deepseek-r1chat'), PRICING.v3legacy, 'embedded r1 is not standalone → falls through to /chat/');
  assert.equal(costTable('deepseek-r1x'), PRICING.flash, 'embedded r1 not standalone, no legacy name → flash default');
});

test('calculateCost: non-deepseek models cost 0', () => {
  assert.equal(calculateCost('glm-4.7', 1e6, 1e6, 1e6, MON_PEAK), 0);
  assert.equal(calculateCost('qwen3-max', 1e6, 1e6, 1e6, MON_PEAK), 0);
  assert.equal(calculateCost(undefined, 1e6, 1e6, 1e6), 0);
});

test('calculateCost: deepseek-chat walks v3legacy table, peak vs off-peak', () => {
  // peak: hit 1 + out 16 (miss=0)
  assert.equal(calculateCost('deepseek-chat', 1e6, 0, 1e6, MON_PEAK), 1 * 1 + 1 * 16);
  // off-peak (半价): hit 0.5 + out 8
  assert.equal(calculateCost('deepseek-chat', 1e6, 0, 1e6, MON_LUNCH), 1 * 0.5 + 1 * 8);
  // miss branch at peak
  assert.equal(calculateCost('deepseek-chat', 0, 2e6, 0, MON_PEAK), 2 * 4);
});

test('calculateCost: flash and v4-pro table mapping (peak tier)', () => {
  assert.equal(calculateCost('deepseek-flash', 1e6, 0, 0, MON_PEAK), PRICING.flash.hit[1]);
  assert.equal(calculateCost('deepseek-flash', 0, 1e6, 1e6, MON_PEAK), PRICING.flash.miss[1] + PRICING.flash.out[1]);
  assert.equal(calculateCost('deepseek-v4-pro', 1e6, 0, 0, MON_PEAK), PRICING.v4pro.hit[1]);
  assert.equal(calculateCost('deepseek-v4-pro', 0, 0, 1e6, MON_NIGHT), PRICING.v4pro.out[0], '03:00 Beijing = off-peak tier');
});

test('calculateCost: reasoner → r1legacy', () => {
  assert.equal(calculateCost('deepseek-reasoner', 1e6, 0, 0, MON_PEAK), PRICING.r1legacy.hit[1]);
  assert.equal(calculateCost('deepseek-r1', 0, 0, 1e6, MON_LUNCH), PRICING.r1legacy.out[0]);
});

const mkState = (over = {}) => ({
  lastTurn: null,
  session: { turns: 0 },
  byTalk: {},
  activeTalkId: null,
  ...over
});

test('pickScoped: active bucket with lastTurn wins for both lt and sess', () => {
  const bktLt = { total: 100, input: 60, output: 40, talkId: 'T1' };
  const st = mkState({
    activeTalkId: 'T1',
    lastTurn: { total: 999, talkId: 'OTHER' },
    byTalk: { T1: { turns: 3, totalTokens: 100, totalInput: 60, outputTokens: 40, hitTokens: 20, lastTurn: bktLt } }
  });
  const { lt, sess } = pickScoped(st);
  assert.equal(lt, bktLt);
  assert.equal(sess.totalInput, 60);
  assert.equal(sess.turns, 3);
});

test('pickScoped: bucket without lastTurn falls back to global legacy entry (talkId null)', () => {
  const g = { total: 50, input: 30, output: 20, talkId: null };
  const st = mkState({
    activeTalkId: 'T1',
    lastTurn: g,
    byTalk: { T1: { turns: 0, totalTokens: 0 } }
  });
  const { lt, sess } = pickScoped(st);
  assert.equal(lt, g, 'legacy archive: global lastTurn with null talkId may fall back');
  assert.equal(sess, null, 'bucket has 0 turns → no session data');
});

test('pickScoped: global lastTurn owned by another talk is rejected (no cross-talk leak)', () => {
  const st = mkState({
    activeTalkId: 'T2',
    lastTurn: { total: 500, talkId: 'T1' },
    byTalk: {}
  });
  const { lt, sess } = pickScoped(st);
  assert.equal(lt, null, 'mismatched talkId → no fallback');
  assert.equal(sess, null);
});

test('pickScoped: no active talk falls back to global lastTurn (compat)', () => {
  const g = { total: 10, talkId: 'T9' };
  const st = mkState({ activeTalkId: null, lastTurn: g, byTalk: {} });
  const { lt, sess } = pickScoped(st);
  assert.equal(lt, g);
  assert.equal(sess, null);
});

test('pickScoped: global lastTurn matching activeTalkId (loose string compare) is accepted', () => {
  const g = { total: 10, talkId: 'T1' };
  const st = mkState({ activeTalkId: 'T1', lastTurn: g, byTalk: {} });
  assert.equal(pickScoped(st).lt, g);
});

test('pickScoped: bucket with turns=0 yields sess null even if present', () => {
  const st = mkState({
    activeTalkId: 'T1',
    lastTurn: { total: 10, talkId: 'T1' },
    byTalk: { T1: { turns: 0, totalTokens: 0, lastTurn: { total: 10, talkId: 'T1' } } }
  });
  const { sess } = pickScoped(st);
  assert.equal(sess, null);
});
