import test from 'node:test';
import assert from 'node:assert/strict';

const {
  PRICING,
  isPeakHour,
  costTable,
  calculateCost,
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
  assert.equal(bucket.stepsSeen.req_1, 1);
  assert.equal(bucket.stepsSeen.req_2, 1);
  assert.equal(bucket.stepsSeen.req_3, 1);
});

