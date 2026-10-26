import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
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

  // 6. DeepSeek Reasoner -> Chat
  {
    const res = resolveSubagentTierSelection({
      parentSelection: { providerId: 'deepseek', modelId: 'deepseek-reasoner' },
      tier: 'fast'
    });
    assert.equal(res.selection.modelId, 'deepseek-chat');
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
