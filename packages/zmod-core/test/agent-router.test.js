import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routerPath = path.resolve(__dirname, '../src/main/agent-router.cjs');
const router = require(routerPath);

test('ZMod Agent Router: known providers tier mapping', () => {
  const { resolveSubagentTierSelection } = router;

  // 1. Google Gemini
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'google', modelId: 'gemini-2.5-pro', options: { reasoningLevel: 'high' } },
      tier: 'fast'
    });
    assert.equal(res.selection.modelId, 'gemini-2.5-flash');
    assert.equal(res.selection.options.reasoningLevel, 'low');
    assert.equal(res.isConcrete, true);
  }

  // 2. Claude Sonnet -> Haiku
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'anthropic', modelId: 'claude-3-7-sonnet' },
      tier: 'fast'
    });
    assert.equal(res.selection.modelId, 'claude-3-5-haiku');
  }

  // 3. OpenAI GPT-4o -> mini
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'openai', modelId: 'gpt-4o' },
      tier: 'fast'
    });
    assert.equal(res.selection.modelId, 'gpt-4o-mini');
  }

  // 4. 百炼 Qwen-Max -> Qwen-Turbo
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'aliyun-bailian', modelId: 'qwen-max' },
      tier: 'fast'
    });
    assert.equal(res.selection.modelId, 'qwen-turbo');
  }

  // 5. 智谱 GLM Explore 子代理自动走 fast
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3' },
      agentType: 'Explore'
    });
    assert.equal(res.selection.modelId, 'GLM-5.3-Flash');
  }

  // 6. DeepSeek Reasoner -> Flash（ZCode 官方 DeepSeek 通道轻量档为 deepseek-flash）
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'deepseek', modelId: 'deepseek-reasoner' },
      tier: 'fast'
    });
    assert.equal(res.selection.modelId, 'deepseek-flash');
  }
});

test('ZMod Agent Router: deepseek & qwen updated lightweight mapping table', () => {
  const { resolveSubagentTierSelection } = router;

  const cases = [
    // DeepSeek：flash 原样；V4 Pro / Reasoner(R1) -> deepseek-flash；V3 Chat（开放平台旧轻量名）原样
    { providerId: 'deepseek', modelId: 'deepseek-flash', expected: 'deepseek-flash', concrete: false },
    { providerId: 'deepseek', modelId: 'deepseek-v4-pro', expected: 'deepseek-flash', concrete: true },
    { providerId: 'deepseek', modelId: 'deepseek-reasoner', expected: 'deepseek-flash', concrete: true },
    { providerId: 'deepseek', modelId: 'deepseek-chat', expected: 'deepseek-chat', concrete: false },
    // Qwen：turbo/flash 原样；3.8 系非 flash -> qwen3.8-flash；旧 max 命名 -> qwen-turbo
    { providerId: 'aliyun-bailian', modelId: 'qwen3.8-max-0902', expected: 'qwen3.8-flash', concrete: true },
    { providerId: 'aliyun-bailian', modelId: 'qwen-max', expected: 'qwen-turbo', concrete: true },
    { providerId: 'aliyun-bailian', modelId: 'qwen3.8-flash', expected: 'qwen3.8-flash', concrete: false },
    // 原有行为保持
    { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3', expected: 'GLM-5.3-Flash', concrete: true },
    { providerId: 'google', modelId: 'gemini-2.5-pro', expected: 'gemini-2.5-flash', concrete: true },
    { providerId: 'anthropic', modelId: 'claude-3-7-sonnet', expected: 'claude-3-5-haiku', concrete: true }
  ];

  for (const c of cases) {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: c.providerId, modelId: c.modelId },
      tier: 'fast'
    });
    assert.equal(res.selection.modelId, c.expected, `${c.providerId}/${c.modelId} -> ${c.expected}`);
    assert.equal(res.isConcrete, c.concrete, `${c.providerId}/${c.modelId} isConcrete=${c.concrete}`);
  }
});

test('ZMod Agent Router: plugin config chain via ZMOD_USER_DATA_DIR', (t) => {
  const { resolveSubagentTierSelection } = router;
  const prevEnv = process.env.ZMOD_USER_DATA_DIR;
  // 独立临时目录（会话结束后由系统临时机制回收）
  const tempDataDir = path.join(os.tmpdir(), 'zcode-scratch', `agent-router-test-${process.pid}-${Date.now()}`);
  const cfgDir = path.join(tempDataDir, 'plugin-data', 'smart-subagent');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'config.json');

  t.after(() => {
    if (prevEnv === undefined) delete process.env.ZMOD_USER_DATA_DIR;
    else process.env.ZMOD_USER_DATA_DIR = prevEnv;
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  // 1. enabled:false：配置链路已通，路由关闭时即使 fast 档也不做任何改写
  process.env.ZMOD_USER_DATA_DIR = tempDataDir;
  fs.writeFileSync(cfgPath, JSON.stringify({ enabled: false }));
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      tier: 'fast'
    });
    assert.equal(res.resolved, false);
    assert.equal(res.selection.modelId, 'deepseek-v4-pro');
  }

  // 2. customRules 自定义映射生效
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    customRules: { 'custom-gateway': 'my-speed-model' }
  }));
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'custom-gateway', modelId: 'whatever-pro' },
      tier: 'fast'
    });
    assert.equal(res.resolved, true);
    assert.equal(res.selection.modelId, 'my-speed-model');
    assert.equal(res.isConcrete, true);
  }

  // 3. customRules 空串值被忽略、不崩溃：回退到启发式/安全兜底
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    customRules: { 'custom-gateway': '' }
  }));
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'custom-gateway', modelId: 'blackbox-engine-v1' },
      tier: 'fast'
    });
    assert.equal(res.resolved, false);
    assert.equal(res.selection.modelId, 'blackbox-engine-v1');
  }
});

test('ZMod Agent Router: unknown provider heuristic & safe fallback', () => {
  const { resolveSubagentTierSelection } = router;

  // 启发式：第三方网关的 pro 模型 -> flash
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'custom-gateway', modelId: 'my-custom-llama-70b-pro' },
      tier: 'fast'
    });
    assert.equal(res.selection.modelId, 'my-custom-llama-70b-flash');
    assert.equal(res.isConcrete, true);
  }

  // 安全兜底：无法识别的黑盒模型 -> 原地继承
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'corp-private-llm', modelId: 'blackbox-engine-v1' },
      tier: 'fast'
    });
    assert.equal(res.selection.modelId, 'blackbox-engine-v1');
    assert.equal(res.isConcrete, false);
  }

  // 标准档位：不降级
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'google', modelId: 'gemini-2.5-pro' },
      tier: 'standard'
    });
    assert.equal(res.selection.modelId, 'gemini-2.5-pro');
    assert.equal(res.isConcrete, false);
  }
});

test('ZMod Agent Router: in-memory patch zero disk tampering', () => {
  const zcodePath = 'D:/ZCode/resources/glm/zcode.cjs';
  if (!fs.existsSync(zcodePath)) return;

  const originalContent = fs.readFileSync(zcodePath, 'utf8');
  const hashBefore = crypto.createHash('sha256').update(originalContent).digest('hex');

  // 验证原版文件确实未包含注入标记
  assert.equal(originalContent.includes('__ZMOD_AGENT_ROUTER__'), false);

  // 验证内存 patcher 函数是否能在内存中打补丁
  const patchedInMemory = router.patchZCodeInMemory(originalContent);

  assert.equal(patchedInMemory.includes('tier:V.enum(["fast","standard","reasoning"])'), true);
  assert.equal(patchedInMemory.includes('globalThis.__ZMOD_AGENT_ROUTER__'), true);

  // 物理磁盘文件哈希不变
  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(zcodePath, 'utf8')).digest('hex');
  assert.equal(hashBefore, hashAfter);
});
