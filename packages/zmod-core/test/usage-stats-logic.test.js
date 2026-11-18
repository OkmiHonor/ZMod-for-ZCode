import test from 'node:test';
import assert from 'node:assert/strict';

const {
  PRICING,
  BAILIAN_PRICING,
  EXTENDED_PRICING,
  isPeakHour,
  isSubscriptionModel,
  isSubscriptionProvider,
  costTable,
  calculateCost,
  formatCost,
  quotaTable,
  parseCustomQuotaEntry,
  resolveQuotaTable,
  calculateQuotaPercent,
  countQuotaRequests,
  computeWindowQuotaUsage,
  formatQuotaReset,
  mapAntigravityQuota,
  mapMagpieQuota,
  quotaBucketGroup,
  buildBucketFromRequests,
  ingestTelemetryPayload,
  pickScoped
} = await import('../../../plugins/usage-stats/lib.js');

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

test('costTable: magpie 订阅源（zcode/ 前缀）禁套百炼价', () => {
  assert.equal(isSubscriptionModel('zcode/GLM-5.3-Flash'), true, 'magpie 遥测 model_id 原样');
  assert.equal(isSubscriptionModel('x-zcode/glm'), false, '连字符复合词不算');
  assert.equal(isSubscriptionModel('magpie/zcode/GLM-5.3-Flash'), true, '带渠道前缀的完整形态');
  assert.equal(isSubscriptionModel('GLM-5.3-Flash'), false, '官方 zai 渠道无前缀');
  assert.equal(isSubscriptionModel(''), false);
  assert.equal(costTable('zcode/GLM-5.3-Flash'), null, '订阅制不计价');
  assert.equal(costTable('zcode/glm-5.3-flash'), null, '小写同样命中');
  assert.equal(calculateCost('zcode/GLM-5.3-Flash', 1e6, 1e6, 1e6, MON_PEAK), 0);
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

test('pickScoped: domTalkId "draft" isolates draft session from previous talk', () => {
  const st = mkState({
    activeTalkId: 'T_OLD',
    lastTurn: { total: 1000, input: 800, output: 200, talkId: 'T_OLD' },
    byTalk: {
      T_OLD: {
        turns: 2,
        totalTokens: 1000,
        totalInput: 800,
        outputTokens: 200,
        hitTokens: 400,
        lastTurn: { total: 1000, input: 800, output: 200, talkId: 'T_OLD' }
      }
    }
  });
  assert.deepEqual(pickScoped(st, 'draft'), { lt: null, sess: null });
  assert.deepEqual(pickScoped(st, 'T_NEW'), { lt: null, sess: null });

  const stDraftActive = mkState({ ...st, activeTalkId: 'draft' });
  assert.deepEqual(pickScoped(stDraftActive), { lt: null, sess: null });
});

test('ingestTelemetryPayload: concurrent interleaved agent_steps across two sessions do not leak, reset lastTurn, or inflate turns', () => {
  const st = mkState({ activeTalkId: 'TALK_A' });

  // Session A step 1 (foreground)
  assert.equal(
    ingestTelemetryPayload(
      st,
      {
        elementName: 'agent_step',
        talkId: 'TALK_A',
        messageId: 'MSG_A1',
        eventExtraDetail: {
          step_id: 'step_a1',
          step_type: 'reasoning', // model emitted thought + tool call directly
          token_usage_scope: 'model_request',
          model_name: 'deepseek-chat',
          input_tokens: 1000,
          cached_tokens: 600,
          output_tokens: 100
        }
      },
      { now: 1000, date: MON_PEAK, updateActiveTalk: false }
    ),
    true
  );

  // Session B step 1 (background session running concurrently)
  assert.equal(
    ingestTelemetryPayload(
      st,
      {
        elementName: 'agent_step',
        talkId: 'TALK_B',
        messageId: 'MSG_B1',
        eventExtraDetail: {
          step_id: 'step_b1',
          step_type: 'generation',
          token_usage_scope: 'model_request',
          model_name: 'glm-5.1',
          input_tokens: 2000,
          cached_tokens: 1500,
          output_tokens: 300
        }
      },
      { now: 1100, date: MON_PEAK, updateActiveTalk: false }
    ),
    true
  );

  // Foreground activeTalkId must stay locked on TALK_A
  assert.equal(st.activeTalkId, 'TALK_A');

  // Session A step 2 (same message MSG_A1)
  assert.equal(
    ingestTelemetryPayload(
      st,
      {
        elementName: 'agent_step',
        talkId: 'TALK_A',
        messageId: 'MSG_A1',
        eventExtraDetail: {
          step_id: 'step_a2',
          step_type: 'generation',
          token_usage_scope: 'model_request',
          model_name: 'deepseek-chat',
          input_tokens: 1500,
          cached_tokens: 1200,
          output_tokens: 200
        }
      },
      { now: 1200, date: MON_PEAK, updateActiveTalk: false }
    ),
    true
  );

  // Session B step 2 (same message MSG_B1)
  assert.equal(
    ingestTelemetryPayload(
      st,
      {
        elementName: 'agent_step',
        talkId: 'TALK_B',
        messageId: 'MSG_B1',
        eventExtraDetail: {
          step_id: 'step_b2',
          step_type: 'generation',
          token_usage_scope: 'model_request',
          model_name: 'glm-5.1',
          input_tokens: 3000,
          cached_tokens: 2500,
          output_tokens: 400
        }
      },
      { now: 1300, date: MON_PEAK, updateActiveTalk: false }
    ),
    true
  );

  const bkA = st.byTalk.TALK_A;
  const bkB = st.byTalk.TALK_B;

  assert.equal(bkA.turns, 1, 'TALK_A must have exactly 1 turn');
  assert.equal(bkA.totalInput, 2500);
  assert.equal(bkA.outputTokens, 300);
  assert.equal(bkA.hitTokens, 1800);
  assert.equal(bkA.lastTurn.input, 2500, 'TALK_A lastTurn must sum step 1 + step 2');
  assert.equal(bkA.lastTurn.output, 300);
  assert.equal(bkA.lastTurn.hit, 1800);

  assert.equal(bkB.turns, 1, 'TALK_B must have exactly 1 turn');
  assert.equal(bkB.totalInput, 5000);
  assert.equal(bkB.outputTokens, 700);
  assert.equal(bkB.hitTokens, 4000);
  assert.equal(bkB.lastTurn.input, 5000, 'TALK_B lastTurn must sum step 1 + step 2');
  assert.equal(bkB.lastTurn.output, 700);
  assert.equal(bkB.lastTurn.hit, 4000);

  // Foreground pickScoped sees TALK_A only
  const scopedA = pickScoped(st, 'TALK_A');
  assert.equal(scopedA.lt.input, 2500);
  assert.equal(scopedA.sess.totalInput, 2500);

  // Switching DOM to TALK_B sees TALK_B only
  const scopedB = pickScoped(st, 'TALK_B');
  assert.equal(scopedB.lt.input, 5000);
  assert.equal(scopedB.sess.totalInput, 5000);
});

test('ingestTelemetryPayload: agent_step + message_completion and page reload do not double count', () => {
  const st = mkState({ activeTalkId: 'TALK_1' });

  // 1. Ingest agent_step for MSG_100
  assert.equal(
    ingestTelemetryPayload(
      st,
      {
        elementName: 'agent_step',
        talkId: 'TALK_1',
        messageId: 'MSG_100',
        eventExtraDetail: {
          step_id: 's_100_1',
          step_type: 'reasoning',
          token_usage_scope: 'model_request',
          model_name: 'glm-5.1',
          input_tokens: 4000,
          cache_read_input_tokens: 3000,
          output_tokens: 500
        }
      },
      { now: 2000 }
    ),
    true
  );

  // Duplicate step_id is rejected
  assert.equal(
    ingestTelemetryPayload(
      st,
      {
        elementName: 'agent_step',
        talkId: 'TALK_1',
        messageId: 'MSG_100',
        eventExtraDetail: {
          step_id: 's_100_1',
          step_type: 'reasoning',
          token_usage_scope: 'model_request',
          model_name: 'glm-5.1',
          input_tokens: 4000,
          cache_read_input_tokens: 3000,
          output_tokens: 500
        }
      },
      { now: 2010 }
    ),
    false
  );

  // 2. message_completion for same MSG_100 is rejected
  assert.equal(
    ingestTelemetryPayload(
      st,
      {
        elementName: 'message_completion',
        talkId: 'TALK_1',
        messageId: 'MSG_100',
        eventExtraDetail: {
          model_name: 'glm-5.1',
          input_tokens: 4000,
          cache_read_input_tokens: 3000,
          output_tokens: 500
        }
      },
      { now: 2100 }
    ),
    false
  );

  assert.equal(st.byTalk.TALK_1.turns, 1);
  assert.equal(st.byTalk.TALK_1.totalInput, 4000);

  // 3. Simulate page reload: serialize and restore state from JSON (no in-memory Set)
  const reloadedState = JSON.parse(JSON.stringify(st));
  assert.equal(
    ingestTelemetryPayload(
      reloadedState,
      {
        elementName: 'message_completion',
        talkId: 'TALK_1',
        messageId: 'MSG_100',
        eventExtraDetail: {
          model_name: 'glm-5.1',
          input_tokens: 4000,
          cache_read_input_tokens: 3000,
          output_tokens: 500
        }
      },
      { now: 3000 }
    ),
    false,
    'reloaded state must still reject duplicate message_completion for MSG_100'
  );
  assert.equal(reloadedState.byTalk.TALK_1.turns, 1);
  assert.equal(reloadedState.byTalk.TALK_1.totalInput, 4000);
});

test('buildBucketFromRequests: aggregates SQLite model_usage rows by turnId with DeepSeek cost', () => {
  const peakTs = MON_PEAK.getTime();
  const rows = [
    {
      id: 'req_1',
      turnId: 'turn_1',
      modelId: 'deepseek-chat',
      startedAt: peakTs,
      input: 1_000_000,
      output: 500_000,
      reasoning: 0,
      cached: 600_000
    },
    {
      id: 'req_2',
      turnId: 'turn_1',
      modelId: 'deepseek-chat',
      startedAt: peakTs + 1000,
      input: 1_000_000,
      output: 500_000,
      reasoning: 0,
      cached: 800_000
    },
    {
      id: 'req_3',
      turnId: 'turn_2',
      modelId: 'deepseek-chat',
      startedAt: peakTs + 5000,
      input: 500_000,
      output: 100_000,
      reasoning: 20_000,
      cached: 400_000
    }
  ];

  const bucket = buildBucketFromRequests('SESS_DB_1', rows, true);
  assert.equal(bucket.fromDb, true);
  assert.equal(bucket.turns, 2);
  assert.equal(bucket.totalInput, 2_500_000);
  assert.equal(bucket.outputTokens, 1_100_000);
  assert.equal(bucket.hitTokens, 1_800_000);
  assert.equal(bucket.missTokens, 700_000);
  assert.equal(bucket.reasoningTokens, 20_000);
  assert.equal(bucket.totalTokens, 3_600_000);
  assert.ok(bucket.totalCost > 0);

  // lastTurn must be turn_2
  assert.ok(bucket.lastTurn);
  assert.equal(bucket.lastTurn.turnId, 'turn_2');
  assert.equal(bucket.lastTurn.input, 500_000);
  assert.equal(bucket.lastTurn.output, 100_000);
  assert.equal(bucket.lastTurn.hit, 400_000);

  // turn_1 aggregated both req_1 and req_2
  assert.equal(bucket.turnsById.turn_1.input, 2_000_000);
  assert.equal(bucket.turnsById.turn_1.output, 1_000_000);
  assert.equal(bucket.turnsById.turn_1.hit, 1_400_000);
  assert.equal(bucket.turnsById.turn_1.reqCount, 2, 'req_1 + req_2 = 2 distinct requests');
  assert.equal(bucket.turnsById.turn_2.reqCount, 1);
  assert.equal(bucket.reqCount, 3);
  assert.equal(bucket.stepsSeen.req_1, 1);
  assert.equal(bucket.stepsSeen.req_2, 1);
  assert.equal(bucket.stepsSeen.req_3, 1);
});

test('costTable: bailian snapshots win over official deepseek tables', () => {
  assert.equal(costTable('deepseek-v4.1-flash'), BAILIAN_PRICING.dsv41flash);
  assert.equal(costTable('deepseek-v4.1-flash-1017'), BAILIAN_PRICING.dsv41flash, '-1017 snapshot stays bailian');
  assert.equal(costTable('deepseek-v4-pro-0813'), BAILIAN_PRICING.dsv4pro, '-0813 snapshot → bailian dsv4pro');
  assert.equal(costTable('deepseek-v4-pro'), PRICING.v4pro, 'bare v4-pro stays official tiered table');
  assert.equal(costTable('qwen3.8-max'), BAILIAN_PRICING.qwen38max);
  assert.equal(costTable('qwen3.8-max-0902'), BAILIAN_PRICING.qwen38max);
  assert.equal(costTable('qwen3.8-flash'), BAILIAN_PRICING.qwen38flash);
  assert.equal(costTable('glm-5.3'), BAILIAN_PRICING.glm53);
  assert.equal(costTable('glm-5.2'), BAILIAN_PRICING.glm53);
  assert.equal(costTable('kimi-k3'), null, 'unknown family → null (宁缺勿错)');
  assert.equal(costTable('gpt-5.2'), null);
  // 原 deepseek 分支全部保持
  assert.equal(costTable('deepseek-flash'), PRICING.flash);
  assert.equal(costTable('deepseek-v4-pro-preview'), PRICING.v4pro);
  assert.equal(costTable('deepseek-reasoner'), PRICING.r1legacy);
  assert.equal(costTable('deepseek-r1'), PRICING.r1legacy);
  assert.equal(costTable('deepseek-chat'), PRICING.v3legacy);
  assert.equal(costTable('deepseek-v3'), PRICING.v3legacy);
  assert.equal(costTable('deepseek-something-new'), PRICING.flash);
});

test('calculateCost: bailian fixed table — no peak/off-peak, no cache discount tier', () => {
  // qwen3.8-max: 入 100万 × 12 + 出 50万 × 36 = 12 + 18 = 30 元
  assert.equal(calculateCost('qwen3.8-max', 0, 1e6, 0.5e6, MON_PEAK), 30);
  assert.equal(calculateCost('qwen3.8-max', 0, 1e6, 0.5e6, MON_NIGHT), 30, '峰谷同价（无峰谷档）');
  assert.equal(calculateCost('qwen3.8-max', 1e6, 0, 0.5e6, MON_PEAK), 30, 'cached+miss 合计入价，无缓存折扣');
  // deepseek-v4.1-flash: 入 200万 × 1 + 出 100万 × 4 = 6 元
  assert.equal(calculateCost('deepseek-v4.1-flash', 0, 2e6, 1e6, MON_PEAK), 6);
  assert.equal(calculateCost('deepseek-v4.1-flash', 0, 2e6, 1e6, MON_NIGHT), 6, '两个时段同值 = 无峰谷');
  // deepseek-v4-pro-0813 → 百炼 dsv4pro：入 100万 × 4.5 + 出 100万 × 13.5 = 18
  assert.equal(calculateCost('deepseek-v4-pro-0813', 1e6, 0, 1e6, MON_PEAK), 4.5 + 13.5);
});

test('calculateCost: bare deepseek-v4-pro keeps official tiered spread', () => {
  const peak = calculateCost('deepseek-v4-pro', 0, 1e6, 1e6, MON_PEAK);
  const offPeak = calculateCost('deepseek-v4-pro', 0, 1e6, 1e6, MON_NIGHT);
  assert.equal(peak, PRICING.v4pro.miss[1] + PRICING.v4pro.out[1]);
  assert.equal(offPeak, PRICING.v4pro.miss[0] + PRICING.v4pro.out[0]);
  assert.notEqual(peak, offPeak, 'official v4pro keeps peak/off-peak spread');
});

test('formatCost: >=0.01 → 3 decimals, <0.01 → 4 decimals', () => {
  assert.equal(formatCost(0.0004), '0.0004');
  assert.equal(formatCost(0.0123), '0.012');
  assert.equal(formatCost(1.5), '1.500');
  assert.equal(formatCost(0), '0.0000');
  assert.equal(formatCost(NaN), '0.0000');
  assert.equal(formatCost(0.00999), '0.0100', 'rounds up across the 0.01 boundary');
});

test('quotaTable: gemini flash/pro tiers for 5h/weekly/daily windows, non-gemini null', () => {
  // 默认 5小时额度窗口 (5h)
  assert.equal(quotaTable('gemini-3.8-flash').limit, 150);
  assert.equal(quotaTable('gemini-3.8-flash').windowLabel, '5小时额度');
  assert.equal(quotaTable('Gemini-3.8-Flash').limit, 150, 'case-insensitive flash tier');
  assert.equal(quotaTable('gemini-3.8-pro').limit, 50);
  assert.equal(quotaTable('gemini-whatever').limit, 50, 'non-flash gemini defaults to pro tier');
  assert.ok(quotaTable('gemini-3.8-pro').label.includes('Google AI Pro'));
  assert.ok(quotaTable('gemini-3.8-pro').label.includes('5小时额度'));

  // 周额度窗口 (weekly)
  assert.equal(quotaTable('gemini-3.8-flash', 'weekly').limit, 1500);
  assert.equal(quotaTable('gemini-3.8-pro', 'weekly').limit, 500);
  assert.equal(quotaTable('gemini-3.8-pro', 'weekly').windowLabel, '周额度');
  assert.ok(quotaTable('gemini-3.8-pro', 'weekly').label.includes('周额度'));

  // 日额度兼容 (daily)
  assert.equal(quotaTable('gemini-3.8-flash', 'daily').daily, 250);
  assert.equal(quotaTable('gemini-3.8-pro', 'daily').daily, 100);

  // 非 gemini 返回 null
  assert.equal(quotaTable('kimi-k3'), null);
  assert.equal(quotaTable(''), null);
  assert.equal(quotaTable(undefined), null);
});

test('resolveQuotaTable: custom dict overrides builtin, invalid input falls back', () => {
  assert.equal(resolveQuotaTable('gemini-3.8-pro', { 'gemini-3.8-pro': 150 }).limit, 150, 'object form');
  assert.equal(resolveQuotaTable('gemini-3.8-pro', '{"gemini-3.8-pro": 150}').limit, 150, 'JSON string form');
  assert.equal(resolveQuotaTable('GEMINI-3.8-PRO', { 'gemini-3.8-pro': 42 }).limit, 42, 'case-insensitive key hit');
  assert.equal(resolveQuotaTable('gemini-3.8-pro', '{invalid json').limit, 50, '非法 JSON 不崩 → builtin 5h');
  assert.equal(resolveQuotaTable('gemini-3.8-pro', '{"gemini-3.8-pro": 0}').limit, 50, '非正值回退 builtin 5h');
  assert.equal(resolveQuotaTable('gemini-3.8-pro', {}, 'weekly').limit, 500, 'no key hit + weekly → weekly builtin');
  assert.equal(resolveQuotaTable('gemini-3.8-pro', null).limit, 50);
  assert.equal(resolveQuotaTable('gemini-3.8-pro', '[1,2]').limit, 50, 'array is not a dict → builtin');
  const custom = resolveQuotaTable('kimi-k3', { 'kimi-k3': 42 });
  assert.equal(custom.limit, 42, 'custom may cover models without builtin rule');
  assert.equal(custom.custom, true);
  assert.equal(resolveQuotaTable('kimi-k3', { 'other': 42 }), null, 'no builtin + no custom hit → null');
});

test('calculateQuotaPercent: builtin / custom override / no-table zero', () => {
  // 5h 窗口 (pro=50, flash=150)
  assert.equal(calculateQuotaPercent('gemini-3.8-pro', 25, null, '5h'), 50);
  assert.ok(Math.abs(calculateQuotaPercent('gemini-3.8-flash', 150, null, '5h') - 100) < 1e-9);

  // weekly 窗口 (pro=500)
  assert.equal(calculateQuotaPercent('gemini-3.8-pro', 250, null, 'weekly'), 50);

  // 自定义覆盖
  assert.ok(Math.abs(calculateQuotaPercent('gemini-3.8-pro', 75, '{"gemini-3.8-pro": 150}') - 50) < 1e-9);
  assert.ok(calculateQuotaPercent('gemini-3.8-pro', 250, null) > 100, 'may exceed 100');
  assert.equal(calculateQuotaPercent('kimi-k3', 10, null), 0, 'no quota table → 0');
  assert.equal(calculateQuotaPercent('gemini-3.8-pro', undefined, null), 0);
});

const mkStepPayload = (over = {}) => {
  const { eventExtraDetail, ...rest } = over;
  return {
    elementName: 'agent_step',
    talkId: 'TALK_RQ',
    messageId: 'MSG_RQ1',
    eventExtraDetail: {
      step_id: 'step_rq',
      step_type: 'generation',
      token_usage_scope: 'model_request',
      model_request_id: '',
      model_name: 'qwen3.8-max',
      input_tokens: 1000,
      cached_tokens: 0,
      output_tokens: 100,
      ...(eventExtraDetail || {})
    },
    ...rest
  };
};

test('reqCount: two distinct model_request_ids in one turn → turn/bucket/session all 2', () => {
  const st = mkState({ activeTalkId: 'TALK_RQ' });
  assert.equal(
    ingestTelemetryPayload(
      st,
      mkStepPayload({ eventExtraDetail: { step_id: 's1', model_request_id: 'req_r1', model_name: 'qwen3.8-max', input_tokens: 1000, cached_tokens: 500, output_tokens: 100 } }),
      { now: 1000 }
    ),
    true
  );
  assert.equal(
    ingestTelemetryPayload(
      st,
      mkStepPayload({ eventExtraDetail: { step_id: 's2', model_request_id: 'req_r2', model_name: 'qwen3.8-max', input_tokens: 2000, cached_tokens: 800, output_tokens: 200 } }),
      { now: 1100 }
    ),
    true
  );
  const bk = st.byTalk.TALK_RQ;
  assert.equal(bk.turns, 1, 'same messageId → still one turn');
  assert.equal(bk.turnsById.MSG_RQ1.reqCount, 2);
  assert.equal(bk.reqCount, 2);
  assert.equal(st.session.reqCount, 2);
  assert.equal(st.lastTurn.reqCount, 2);
  // duplicate model_request_id (new step_id) must not add another request
  assert.equal(
    ingestTelemetryPayload(
      st,
      mkStepPayload({ eventExtraDetail: { step_id: 's3', model_request_id: 'req_r2', model_name: 'qwen3.8-max', input_tokens: 3000, output_tokens: 300 } }),
      { now: 1200 }
    ),
    false,
    'seen model_request_id is rejected by the gate'
  );
  assert.equal(bk.reqCount, 2);
  assert.equal(bk.turnsById.MSG_RQ1.reqCount, 2);
});

test('reqCount: message_completion solo turn → reqCount=1; dedup paths never inflate', () => {
  const st = mkState({ activeTalkId: 'TALK_RQ2' });
  const donePayload = {
    elementName: 'message_completion',
    talkId: 'TALK_RQ2',
    messageId: 'MSG_C1',
    eventExtraDetail: { model_name: 'glm-5.3', input_tokens: 500, output_tokens: 100 }
  };
  assert.equal(ingestTelemetryPayload(st, donePayload, { now: 1000 }), true);
  assert.equal(st.byTalk.TALK_RQ2.turnsById.MSG_C1.reqCount, 1);
  assert.equal(st.byTalk.TALK_RQ2.reqCount, 1);
  assert.equal(st.session.reqCount, 1);
  // duplicate completion rejected → reqCount unchanged
  assert.equal(ingestTelemetryPayload(st, donePayload, { now: 1100 }), false);
  assert.equal(st.byTalk.TALK_RQ2.reqCount, 1);

  // turn already established by a step: completion must not add another request
  const st2 = mkState({ activeTalkId: 'TALK_RQ3' });
  assert.equal(
    ingestTelemetryPayload(
      st2,
      mkStepPayload({ talkId: 'TALK_RQ3', messageId: 'MSG_S1', eventExtraDetail: { step_id: 'ss1', model_request_id: 'rq1', model_name: 'glm-5.3', input_tokens: 100, output_tokens: 10 } }),
      { now: 1000 }
    ),
    true
  );
  assert.equal(
    ingestTelemetryPayload(
      st2,
      {
        elementName: 'message_completion',
        talkId: 'TALK_RQ3',
        messageId: 'MSG_S1',
        eventExtraDetail: { model_name: 'glm-5.3', input_tokens: 100, output_tokens: 10 }
      },
      { now: 1100 }
    ),
    false
  );
  assert.equal(st2.byTalk.TALK_RQ3.turnsById.MSG_S1.reqCount, 1);
  assert.equal(st2.byTalk.TALK_RQ3.reqCount, 1);
});

test('buildBucketFromRequests: reqCount dedups by logicalRequestId and sums per bucket', () => {
  const peakTs = MON_PEAK.getTime();
  const rows = [
    { id: 'r1', logicalRequestId: 'L1', turnId: 't1', modelId: 'qwen3.8-max', startedAt: peakTs, input: 1e6, output: 1e5, cached: 0 },
    { id: 'r2', logicalRequestId: 'L1', turnId: 't1', modelId: 'qwen3.8-max', startedAt: peakTs + 100, input: 1e6, output: 1e5, cached: 0 },
    { id: 'r3', logicalRequestId: 'L2', turnId: 't1', modelId: 'qwen3.8-max', startedAt: peakTs + 200, input: 1e6, output: 1e5, cached: 0 },
    { id: 'r4', turnId: 't2', modelId: 'deepseek-chat', startedAt: peakTs + 300, input: 1e6, output: 1e5, cached: 0 }
  ];
  const bucket = buildBucketFromRequests('SESS_RQ', rows, true);
  assert.equal(bucket.turnsById.t1.reqCount, 2, 'L1 counted once within t1');
  assert.equal(bucket.turnsById.t2.reqCount, 1);
  assert.equal(bucket.reqCount, 3);
  assert.equal(bucket.lastTurn.turnId, 't2');
  assert.equal(bucket.lastTurn.reqCount, 1);
});

/* ---- v1.4.2: Google 桶组归属 + 滚动窗口额度估算 + Antigravity 网关真实余量 ---- */

test('quotaBucketGroup: argon split from gemini family, non-gemini null', () => {
  assert.equal(quotaBucketGroup('gemini-3.8-flash'), 'gemini', 'flash shares the Gemini Models group');
  assert.equal(quotaBucketGroup('gemini-3.8-pro'), 'gemini');
  assert.equal(quotaBucketGroup('Gemini-3.8-Flash'), 'gemini', 'case-insensitive');
  assert.equal(quotaBucketGroup('gemini-4-argon'), 'gemini-argon', 'argon has its own quota group');
  assert.equal(quotaBucketGroup('gemini-4-argon-low'), 'gemini-argon', 'effort suffix keeps argon group');
  assert.equal(quotaBucketGroup('gemini-4-argon-high'), 'gemini-argon');
  assert.equal(quotaBucketGroup('claude-sonnet-5-5'), null, 'claude models hit no google group');
  assert.equal(quotaBucketGroup('zcode/GLM-5.3-Flash'), null);
  assert.equal(quotaBucketGroup(''), null);
  assert.equal(quotaBucketGroup(undefined), null);
});

test('countQuotaRequests: rolling window + same-group only (fixes session-accumulate & cross-model mixing)', () => {
  const NOW = Date.UTC(2026, 10, 4, 12, 0); // 固定"当前时刻"
  const H = 3600000;
  const events = [
    { m: 'gemini-3.8-flash', t: NOW - 1 * H },   // 窗口内 gemini 组
    { m: 'gemini-3.8-pro', t: NOW - 2 * H },     // 窗口内 gemini 组（flash/pro 共享桶组互相挤占）
    { m: 'gemini-3.8-flash', t: NOW - 4 * H },   // 窗口内
    { m: 'gemini-3.8-flash', t: NOW - 6 * H },   // 窗口外（>5h）→ 不计
    { m: 'gemini-4-argon', t: NOW - 1 * H },     // argon 独立桶组 → 不计入 gemini 组
    { m: 'zcode/GLM-5.3-Flash', t: NOW - 1 * H },// 非 gemini → 永不计入
    { m: 'claude-sonnet-5-5', t: NOW - 1 * H }   // 非 gemini → 永不计入
  ];
  // gemini 组窗口内 = flash ×2 + pro ×1 = 3（旧口径会把全部 7 条都算上）
  assert.equal(countQuotaRequests(events, 'gemini-3.8-flash', '5h', NOW), 3);
  // argon 模型只数 argon 组请求
  assert.equal(countQuotaRequests(events, 'gemini-4-argon', '5h', NOW), 1);
  assert.equal(countQuotaRequests(events, 'gemini-4-argon-low', '5h', NOW), 1);
  // 非 gemini 模型没有桶组 → 恒 0
  assert.equal(countQuotaRequests(events, 'zcode/GLM-5.3-Flash', '5h', NOW), 0);
  assert.equal(countQuotaRequests(events, 'gemini-3.8-flash', '5h', NOW + 2 * H), 2, '窗口滚动 2h 后：4h 前与 6h 前的请求出窗，剩 1h/2h 前两条');

  // 边界：恰好 5h 前的请求计入（t >= now - 5h 闭区间）
  const edge = [{ m: 'gemini-3.8-flash', t: NOW - 5 * H }];
  assert.equal(countQuotaRequests(edge, 'gemini-3.8-flash', '5h', NOW), 1);

  // weekly / daily 窗口时长
  const weekEvents = [
    { m: 'gemini-3.8-flash', t: NOW - 6 * 24 * H },  // 6 天前：weekly 计入，daily 不计
    { m: 'gemini-3.8-flash', t: NOW - 8 * 24 * H }   // 8 天前：weekly 也不计
  ];
  assert.equal(countQuotaRequests(weekEvents, 'gemini-3.8-flash', 'weekly', NOW), 1);
  assert.equal(countQuotaRequests(weekEvents, 'gemini-3.8-flash', 'daily', NOW), 0);

  // 缺失/非法 events 容错
  assert.equal(countQuotaRequests(null, 'gemini-3.8-flash', '5h', NOW), 0);
  assert.equal(countQuotaRequests(undefined, 'gemini-3.8-flash', '5h', NOW), 0);
  assert.equal(countQuotaRequests([null, {}, { m: 'gemini-3.8-flash' }], 'gemini-3.8-flash', '5h', NOW), 0, '无 t 的条目无法定位窗口 → 保守不计');
});

test('buildBucketFromRequests: reqEvents carry model + startedAt, deduped with reqCount', () => {
  const peakTs = MON_PEAK.getTime();
  const rows = [
    { id: 'r1', logicalRequestId: 'L1', turnId: 't1', modelId: 'gemini-3.8-flash', startedAt: peakTs, input: 1e3, output: 1e2, cached: 0 },
    { id: 'r2', logicalRequestId: 'L1', turnId: 't1', modelId: 'gemini-3.8-flash', startedAt: peakTs + 100, input: 1e3, output: 1e2, cached: 0 },
    { id: 'r3', logicalRequestId: 'L2', turnId: 't2', modelId: 'zcode/GLM-5.3-Flash', startedAt: peakTs + 200, input: 1e3, output: 1e2, cached: 0 }
  ];
  const bucket = buildBucketFromRequests('SESS_EV', rows, true);
  assert.deepEqual(bucket.reqEvents, [
    { m: 'gemini-3.8-flash', t: peakTs },
    { m: 'zcode/GLM-5.3-Flash', t: peakTs + 200 }
  ], 'one event per distinct logical request, model + epoch ms preserved');
  assert.equal(countQuotaRequests(bucket.reqEvents, 'gemini-3.8-flash', '5h', peakTs + 1000), 1,
    'DB-calibrated bucket feeds the rolling-window counter');
});

test('ingestTelemetryPayload: reqEvents appended per new request, dedup gate keeps them stable', () => {
  const st = mkState({ activeTalkId: 'TALK_EV' });
  assert.equal(
    ingestTelemetryPayload(st, mkStepPayload({ talkId: 'TALK_EV', messageId: 'M1', eventExtraDetail: { step_id: 's1', model_request_id: 'rq1', model_name: 'gemini-3.8-flash', input_tokens: 100, output_tokens: 10 } }), { now: 5000 }),
    true
  );
  assert.equal(
    ingestTelemetryPayload(st, mkStepPayload({ talkId: 'TALK_EV', messageId: 'M1', eventExtraDetail: { step_id: 's2', model_request_id: 'rq2', model_name: 'gemini-4-argon', input_tokens: 100, output_tokens: 10 } }), { now: 6000 }),
    true
  );
  // duplicate model_request_id rejected → no new event
  assert.equal(
    ingestTelemetryPayload(st, mkStepPayload({ talkId: 'TALK_EV', messageId: 'M1', eventExtraDetail: { step_id: 's3', model_request_id: 'rq2', model_name: 'gemini-4-argon', input_tokens: 100, output_tokens: 10 } }), { now: 7000 }),
    false
  );
  const bk = st.byTalk.TALK_EV;
  assert.deepEqual(bk.reqEvents, [
    { m: 'gemini-3.8-flash', t: 5000 },
    { m: 'gemini-4-argon', t: 6000 }
  ]);
  assert.equal(countQuotaRequests(bk.reqEvents, 'gemini-4-argon', '5h', 7000), 1, 'argon group isolated inside live telemetry too');

  // 老存档桶（无 reqEvents 字段）不崩，自动补空数组
  const legacy = mkState({ activeTalkId: 'TALK_OLD', byTalk: { TALK_OLD: { turns: 1, reqCount: 2, turnsById: {}, stepsSeen: {} } } });
  assert.equal(
    ingestTelemetryPayload(legacy, mkStepPayload({ talkId: 'TALK_OLD', messageId: 'M9', eventExtraDetail: { step_id: 's9', model_request_id: 'rq9', model_name: 'gemini-3.8-flash', input_tokens: 100, output_tokens: 10 } }), { now: 9000 }),
    true
  );
  assert.deepEqual(legacy.byTalk.TALK_OLD.reqEvents, [{ m: 'gemini-3.8-flash', t: 9000 }]);
});

test('mapAntigravityQuota: gateway group matching incl. argon split and effort-suffix models', () => {
  const snapshot = {
    ok: true,
    tier: 'PRO',
    lastUpdated: 1793803706,
    groups: [
      {
        name: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { window: 'weekly', frac: 0.8678992, reset: '2026-11-10T05:48:34Z' },
          { window: '5h', frac: 0.98410785, reset: '2026-11-04T19:08:40Z' }
        ]
      },
      {
        name: 'Gemini 4 Argon',
        description: 'For paid Pro plans, Argon quota is separate.',
        buckets: [{ window: 'weekly', frac: 0.7669473, reset: '2026-11-06T09:32:55Z' }]
      },
      {
        name: 'Claude and GPT models',
        description: 'Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [{ window: '5h', frac: 1.0, reset: '2026-11-04T19:48:27Z' }]
      }
    ]
  };
  // gemini 模型（含 effort 后缀变体）→ Gemini Models 组双桶
  const gem = mapAntigravityQuota(snapshot, 'gemini-3.8-flash');
  assert.equal(gem.group, 'gemini');
  assert.equal(gem.tier, 'PRO');
  assert.equal(gem.buckets.length, 2);
  assert.equal(gem.buckets[1].window, '5h');
  assert.ok(Math.abs(gem.buckets[1].frac - 0.98410785) < 1e-9);
  assert.equal(mapAntigravityQuota(snapshot, 'gemini-3.8-flash-low').group, 'gemini');

  // argon 模型 → 独立组，仅周桶（Pro 订阅无 5h 桶）
  const argon = mapAntigravityQuota(snapshot, 'gemini-4-argon');
  assert.equal(argon.group, 'gemini-argon');
  assert.equal(argon.buckets.length, 1);
  assert.equal(argon.buckets[0].window, 'weekly');
  assert.equal(mapAntigravityQuota(snapshot, 'gemini-4-argon-high').group, 'gemini-argon');

  // 非 gemini → null（不消费网关数据）
  assert.equal(mapAntigravityQuota(snapshot, 'claude-sonnet-5-5'), null);
  assert.equal(mapAntigravityQuota(snapshot, ''), null);

  // 非法/缺失容错
  assert.equal(mapAntigravityQuota(null, 'gemini-3.8-flash'), null);
  assert.equal(mapAntigravityQuota({}, 'gemini-3.8-flash'), null);
  assert.equal(mapAntigravityQuota({ groups: 'x' }, 'gemini-3.8-flash'), null);
  assert.equal(mapAntigravityQuota({ groups: [{ name: 'Unknown', buckets: [{ window: '5h', frac: 'bad' }] }] }, 'gemini-3.8-flash'), null, '非数值 frac 的桶被剔除后无匹配组 → null');
  assert.equal(mapAntigravityQuota({ groups: [{ name: 'Broken', buckets: [null, { window: '5h', frac: 0.5 }] }] }, 'gemini-3.8-flash'), null, '组名不匹配 → null');
});

test('formatQuotaReset: countdown buckets and invalid input', () => {
  const NOW = Date.UTC(2026, 10, 4, 12, 0);
  assert.equal(formatQuotaReset('2026-11-04T12:30:00Z', NOW), '30分钟后重置');
  assert.equal(formatQuotaReset('2026-11-04T16:20:00Z', NOW), '4小时20分后重置');
  assert.equal(formatQuotaReset('2026-11-04T16:00:00Z', NOW), '4小时后重置');
  assert.equal(formatQuotaReset('2026-11-06T15:00:00Z', NOW), '2天3小时后重置');
  assert.equal(formatQuotaReset('2026-11-08T12:00:00Z', NOW), '4天后重置');
  assert.equal(formatQuotaReset('2026-11-04T11:00:00Z', NOW), '已重置');
  assert.equal(formatQuotaReset('', NOW), '');
  assert.equal(formatQuotaReset('not-a-date', NOW), '');
  assert.equal(formatQuotaReset(undefined, NOW), '');
});

test('resolveQuotaTable: argon tier explicit via customQuota (configurable chain)', () => {
  // 内置：argon 名字无 flash → pro 档 50/5h（估算基线）
  assert.equal(quotaTable('gemini-4-argon').limit, 50);
  // 自定义按模型覆盖整条链路可用（weekly 窗口同样生效）
  assert.equal(resolveQuotaTable('gemini-4-argon', { 'gemini-4-argon': 200 }, 'weekly').limit, 200);
  assert.equal(resolveQuotaTable('gemini-4-argon', '{"gemini-4-argon": 200}', 'weekly').custom, true);
  assert.equal(resolveQuotaTable('gemini-4-argon', '{}', 'weekly').limit, 500, 'weekly builtin pro tier');
});

test('extendedPricing: GLM-5.3-Flash mispricing fixed, subscription providers zeroed, cacheWrite & multiplier applied', () => {
  // Bare 1-arg costTable never misclassifies GLM-5.3-Flash as deepseek flash
  assert.equal(costTable('GLM-5.3-Flash'), null);
  assert.equal(costTable('zcode/GLM-5.3-Flash', { extended: true }), null, 'zcode/* is free/subscription');
  assert.equal(isSubscriptionProvider('magpie', 'GLM-5.3-Flash'), true);
  assert.equal(costTable('GLM-5.3-Flash', { extended: true, providerId: 'magpie' }), null);
  assert.equal(costTable('GLM-5.3-Flash', { extended: true }), EXTENDED_PRICING.glm53flash);

  // Claude Sonnet with cache read (hit) + cache write (cw) + multiplier
  const claudeCost = calculateCost('claude-sonnet-4-5', 1_000_000, 1_000_000, 100_000, MON_PEAK, {
    extended: true,
    cacheWriteTokens: 400_000,
    priceMultiplier: 0.5
  });
  // hit: 1M * 2.1 = 2.1; cw: 0.4M * 26.25 = 10.5; pureMiss: 0.6M * 21 = 12.6; out: 0.1M * 105 = 10.5 => sum = 35.7 * 0.5 = 17.85
  assert.ok(Math.abs(claudeCost - 17.85) < 1e-6);

  // USD currency conversion (/ 7)
  const usdCost = calculateCost('claude-sonnet-4-5', 0, 1_000_000, 0, MON_PEAK, {
    extended: true,
    currency: '$'
  });
  assert.ok(Math.abs(usdCost - 3.0) < 1e-6);
});

test('buildBucketFromRequests: aggregates subagent & auxiliary queries while preserving main_turn count and model', () => {
  const ts = MON_PEAK.getTime();
  const rows = [
    {
      id: 'm1',
      logicalRequestId: 'L_main_1',
      turnId: 'turn_1',
      modelId: 'deepseek-v4',
      querySource: 'main_turn',
      startedAt: ts,
      input: 10000,
      output: 2000,
      cached: 5000
    },
    {
      id: 's1',
      logicalRequestId: 'L_sub_1',
      turnId: 'sub_turn_1',
      modelId: 'zcode/GLM-5.3-Flash',
      querySource: 'subagent',
      startedAt: ts + 500,
      input: 40000,
      output: 5000,
      cached: 20000
    },
    {
      id: 'a1',
      logicalRequestId: 'L_aux_1',
      turnId: 'aux_turn_1',
      modelId: 'qwen-turbo',
      querySource: 'session_title',
      startedAt: ts + 800,
      input: 1000,
      output: 50,
      cached: 0
    }
  ];

  const bk = buildBucketFromRequests('SESS_MAIN', rows, true, { includeSubagents: true, extendedPricing: true });
  assert.equal(bk.turns, 1, 'subagent and session_title attach to latest main turn instead of inflating turn count');
  assert.equal(bk.reqCount, 3, 'all 3 distinct model requests counted');
  assert.equal(bk.subagentReqCount, 1);
  assert.equal(bk.subagentTokens, 45000);
  assert.equal(bk.totalTokens, 12000 + 45000 + 1050);
  assert.equal(bk.lastTurn.model, 'deepseek-v4', 'auxiliary/subagent model does not overwrite main turn model');
  assert.equal(bk.lastTurn.input, 10000, 'main turn input strictly isolated from subagent tokens');
  assert.equal(bk.lastTurn.output, 2000);
  assert.equal(bk.lastTurn.total, 12000);
  assert.equal(bk.lastTurn.reqCount, 1, 'main turn reqCount isolated from subagent');
  assert.ok(bk.totalEquivCost > 0, 'totalEquivCost computed for session');
  assert.ok(bk.subagentEquivCost > 0, 'subagentEquivCost tracked');

  const bkNoSub = buildBucketFromRequests('SESS_MAIN', rows, true, { includeSubagents: false });
  assert.equal(bkNoSub.reqCount, 1);
  assert.equal(bkNoSub.totalTokens, 12000);
});

test('parseCustomQuotaEntry, resolveQuotaTable & computeWindowQuotaUsage: multi-mode quota ($/¥/tokens/wildcards)', () => {
  assert.deepEqual(parseCustomQuotaEntry('$5'), { limit: 5, unit: 'cost', currency: '$' });
  assert.deepEqual(parseCustomQuotaEntry('¥50'), { limit: 50, unit: 'cost', currency: '¥' });
  assert.deepEqual(parseCustomQuotaEntry('500w'), { limit: 5_000_000, unit: 'tokens' });

  const cq = '{"claude*": "$10", "*": "200w"}';
  const rClaude = resolveQuotaTable('claude-sonnet-4-5', cq, '5h');
  assert.equal(rClaude.limit, 10);
  assert.equal(rClaude.unit, 'cost');
  assert.equal(rClaude.currency, '$');

  const rFallback = resolveQuotaTable('deepseek-v4', cq, '5h');
  assert.equal(rFallback.limit, 2_000_000);
  assert.equal(rFallback.unit, 'tokens');

  const now = Date.now();
  const events = [
    { m: 'claude-sonnet-4-5', t: now - 1000, in: 1_000_000, out: 0, hit: 0, cw: 0 }
  ];
  const usage = computeWindowQuotaUsage(events, 'claude-sonnet-4-5', rClaude, '5h', now);
  assert.equal(usage.unit, 'cost');
  assert.equal(usage.currency, '$');
  assert.ok(Math.abs(usage.used - 3.0) < 1e-6); // 1M input on claude-sonnet = $3.0
  assert.ok(Math.abs(usage.pct - 30.0) < 1e-6);
});

test('mapAntigravityQuota with allowAllGroups & mapMagpieQuota', () => {
  const agSnap = {
    ok: true,
    tier: 'PRO',
    groups: [
      {
        name: 'Claude and GPT models',
        buckets: [{ window: '5h', frac: 0.75, reset: '2026-11-04T19:48:27Z' }]
      }
    ]
  };
  assert.equal(mapAntigravityQuota(agSnap, 'claude-sonnet-4-5'), null, '2-arg default keeps non-gemini null');
  const mappedAg = mapAntigravityQuota(agSnap, 'claude-sonnet-4-5', { allowAllGroups: true });
  assert.equal(mappedAg.group, 'claude-gpt');
  assert.equal(mappedAg.buckets[0].frac, 0.75);

  const mpSnap = {
    ok: true,
    source: 'local-file',
    plan: 'FREE',
    groups: [
      {
        provider: 'zcode',
        plan: 'FREE',
        buckets: [{ window: 'zcode/GLM-5.3-Flash', frac: 0.88, reset: '2026-11-05T15:00:00Z', at: '2026-11-05T14:00:00Z', accountAgent: 'zcode' }]
      }
    ]
  };
  const mappedMp = mapMagpieQuota(mpSnap, 'GLM-5.3-Flash');
  assert.equal(mappedMp.plan, 'FREE');
  assert.equal(mappedMp.buckets.length, 1);
  assert.equal(mappedMp.buckets[0].frac, 0.88);
});

test('mapMagpieQuota: multi-account freshness (at newest wins), no-at fallback frac-min, prefix match, invalid snapshots', () => {
  // 模拟 4 个 zcode 账户的 GLM-5.3-Flash：同一 5h 窗口 → reset 相同，但快照时间 at 不同
  const snap = {
    ok: true,
    source: 'local-file',
    plan: 'ZCODE WEEKEND BUILD',
    groups: [
      {
        name: 'zcode|user1',
        plan: 'ZCODE WEEKEND BUILD',
        buckets: [
          { window: 'GLM-5.3-Flash', frac: 0.519, reset: '2026-11-09T20:00:00Z', at: '2026-11-09T15:22:47Z', accountAgent: 'zcode', display: '51.9%' },
          { window: 'GLM-5.3-Flash', frac: 0.0745, reset: '2026-11-09T20:00:00Z', at: '2026-11-09T00:59:00Z', accountAgent: 'zcode', display: '7.45%' },
          { window: 'GLM-5.3-Flash', frac: 0.098, reset: '2026-11-09T20:00:00Z', at: '2026-11-09T00:59:30Z', accountAgent: 'zcode', display: '9.8%' },
          { window: 'GLM-5.3-Flash', frac: 0.9767, reset: '2026-11-09T20:00:00Z', at: '2026-11-05T10:00:00Z', accountAgent: 'zcode', display: '97.67%' }
        ]
      },
      {
        name: 'antigravity|user1',
        plan: 'ANTIGRAVITY PRO',
        buckets: [
          { window: 'Claude & GPT · 5 hours', frac: 0.3, reset: '2026-11-09T20:00:00Z', at: '2026-11-09T14:00:00Z', accountAgent: 'antigravity' }
        ]
      }
    ]
  };
  const mapped = mapMagpieQuota(snap, 'zcode/GLM-5.3-Flash');
  assert.equal(mapped.plan, 'ZCODE WEEKEND BUILD');
  assert.equal(mapped.buckets.length, 1, '同 reset 不同 at 的 4 桶收敛为 1 桶');
  assert.equal(mapped.buckets[0].frac, 0.519, '取 at 最新（51.9%），不是 frac 最大/最小');
  assert.equal(mapped.buckets[0].reset, '2026-11-09T20:00:00Z', 'reset 原样透传');
  assert.equal(mapped.buckets[0].display, '51.9%', 'display 透传');

  // 基础名（无 zcode/ 前缀）同样命中
  const mappedBare = mapMagpieQuota(snap, 'GLM-5.3-Flash');
  assert.equal(mappedBare.buckets[0].frac, 0.519);

  // at 并列取 frac 最小（保守）
  const tieSnap = {
    ok: true,
    groups: [{ plan: 'P', buckets: [
      { window: 'GLM-5.3-Flash', frac: 0.7, reset: 'R', at: '2026-11-09T15:22:47Z' },
      { window: 'GLM-5.3-Flash', frac: 0.2, reset: 'R', at: '2026-11-09T15:22:47Z' }
    ] }]
  };
  assert.equal(mapMagpieQuota(tieSnap, 'GLM-5.3-Flash').buckets[0].frac, 0.2);

  // 桶无 at 字段（旧契约）→ 降级取 frac 最小，宁可少报不虚报
  const noAtSnap = {
    ok: true,
    groups: [{ plan: 'FREE', buckets: [
      { window: 'GLM-5.3-Flash', frac: 0.519, reset: 'R' },
      { window: 'GLM-5.3-Flash', frac: 0.098, reset: 'R' },
      { window: 'GLM-5.3-Flash', frac: 0.9767, reset: 'R' }
    ] }]
  };
  assert.equal(mapMagpieQuota(noAtSnap, 'GLM-5.3-Flash').buckets[0].frac, 0.098);

  // 词边界回归：GLM-5.3 与 GLM-5.3-Flash 互为前缀，不得互相吸桶
  const famSnap = {
    ok: true,
    groups: [{ plan: 'P', buckets: [
      { window: 'GLM-5.3', frac: 0.9, reset: 'R1', at: '2026-11-09T15:00:00Z' },
      { window: 'GLM-5.3-Flash', frac: 0.1, reset: 'R2', at: '2026-11-09T15:00:00Z' }
    ] }]
  };
  const m53 = mapMagpieQuota(famSnap, 'GLM-5.3');
  assert.equal(m53.buckets.length, 1, 'GLM-5.3 只命中自己的桶');
  assert.equal(m53.buckets[0].frac, 0.9);
  const m53f = mapMagpieQuota(famSnap, 'zcode/GLM-5.3-Flash');
  assert.equal(m53f.buckets.length, 1, 'GLM-5.3-Flash 只命中自己的桶');
  assert.equal(m53f.buckets[0].frac, 0.1);

  // 非法/不匹配快照一律 null，不抛
  assert.equal(mapMagpieQuota(null, 'GLM-5.3-Flash'), null);
  assert.equal(mapMagpieQuota({ ok: false }, 'GLM-5.3-Flash'), null);
  assert.equal(mapMagpieQuota({ ok: true, groups: 'x' }, 'GLM-5.3-Flash'), null, 'groups 非数组 → null');
  assert.equal(mapMagpieQuota({ ok: true, groups: [{ plan: 'P', buckets: [] }] }, 'GLM-5.3-Flash'), null, 'buckets 空 → null');
  assert.equal(
    mapMagpieQuota({ ok: true, groups: [{ buckets: [{ window: 'other-model', frac: 0.5 }] }] }, 'GLM-5.3-Flash'),
    null,
    '模型不匹配 → null'
  );
});


