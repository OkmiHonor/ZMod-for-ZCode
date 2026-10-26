/**
 * ZMod Agent Dynamic Tier Router & In-Memory Preload Hook
 * 
 * 方案 2：纯内存透明注入。
 * 1. 作为 --require 模块加载于 Node.js 子进程中；
 * 2. 仅当目标为 zcode.cjs 进程时生效，通过 Module.prototype._compile 在内存中完成热补丁；
 * 3. 物理磁盘上的 zcode.cjs 保持 100% 原版，零侵入、热插拔、随 ZMod 启停。
 */

"use strict";

/**
 * 已知官方提供商与官方系列的 Flash / 轻量模型映射规则
 */
const KNOWN_TIER_RULES = [
  // Google Gemini 官方渠道或 Gemini 系列官方模型
  {
    matcher: (providerId, modelId) => /google|gemini/i.test(providerId) || /^gemini-/i.test(modelId),
    resolve: (modelId) => {
      if (/flash/i.test(modelId)) return modelId;
      if (/pro/i.test(modelId)) return modelId.replace(/pro/i, "flash");
      return "gemini-2.5-flash";
    }
  },
  // Anthropic Claude 官方渠道或 Claude 系列官方模型
  {
    matcher: (providerId, modelId) => /anthropic|claude/i.test(providerId) || /^claude-/i.test(modelId),
    resolve: (modelId) => {
      if (/haiku/i.test(modelId)) return modelId;
      return "claude-3-5-haiku";
    }
  },
  // OpenAI 官方渠道或 GPT/o系列官方模型
  {
    matcher: (providerId, modelId) => /openai/i.test(providerId) || /^(gpt-|o1|o3)/i.test(modelId),
    resolve: (modelId) => {
      if (/mini/i.test(modelId)) return modelId;
      return "gpt-4o-mini";
    }
  },
  // Aliyun Bailian / DashScope 官方渠道或通义千问官方系列模型
  {
    matcher: (providerId, modelId) => /bailian|dashscope|aliyun/i.test(providerId) || /^qwen/i.test(modelId),
    resolve: (modelId) => {
      if (/turbo|flash/i.test(modelId)) return modelId;
      return "qwen-turbo";
    }
  },
  // Zhipu GLM / BigModel 官方渠道或 GLM 官方系列模型
  {
    matcher: (providerId, modelId) => /bigmodel|zhipu|glm/i.test(providerId) || /^glm-/i.test(modelId),
    resolve: (modelId) => {
      if (/flash/i.test(modelId)) return modelId;
      if (/GLM-5/i.test(modelId)) return "GLM-5.3-Flash";
      if (/GLM-4/i.test(modelId)) return "GLM-4-Flash";
      return "GLM-5.3-Flash";
    }
  },
  // DeepSeek 官方渠道或 DeepSeek 官方系列模型
  {
    matcher: (providerId, modelId) => /deepseek/i.test(providerId) || /^deepseek-/i.test(modelId),
    resolve: (modelId) => {
      if (/chat/i.test(modelId)) return modelId;
      if (/reasoner|r1/i.test(modelId)) return "deepseek-chat";
      return "deepseek-chat";
    }
  }
];

/**
 * 未知源 / 聚合源的通用启发式模型名转换规则
 */
function heuristicTransformModelId(modelId) {
  if (!modelId || typeof modelId !== "string") return null;

  // 如果原本就已经是轻量/快速模型，直接返回
  if (/flash|haiku|mini|turbo|lite|speed/i.test(modelId)) {
    return modelId;
  }

  // 尝试启发式后缀替换（保留前缀命名空间与模型主干）
  if (/pro\b/i.test(modelId)) return modelId.replace(/pro\b/i, "flash");
  if (/sonnet\b/i.test(modelId)) return modelId.replace(/sonnet\b/i, "haiku");
  if (/opus\b/i.test(modelId)) return modelId.replace(/opus\b/i, "haiku");
  if (/max\b/i.test(modelId)) return modelId.replace(/max\b/i, "turbo");
  if (/plus\b/i.test(modelId)) return modelId.replace(/plus\b/i, "turbo");
  if (/reasoner\b/i.test(modelId)) return modelId.replace(/reasoner\b/i, "chat");

  return null;
}

/**
 * 核心模型决议函数
 */
function resolveSubagentTierSelection(params) {
  const { parentSelection, tier, agentType, profile } = params;

  if (!parentSelection || !parentSelection.providerId || !parentSelection.modelId) {
    return { resolved: false, selection: parentSelection, isConcrete: false };
  }

  const isFastRequested =
    tier === "fast" ||
    profile?.tier === "fast" ||
    profile?.model === "auto-flash" ||
    profile?.model === "tier:fast" ||
    agentType === "Explore";

  if (!isFastRequested) {
    return { resolved: false, selection: parentSelection, isConcrete: false };
  }

  const { providerId, modelId, options } = parentSelection;

  // 1. 已知官方规则匹配
  for (const rule of KNOWN_TIER_RULES) {
    if (rule.matcher(providerId, modelId)) {
      const targetModelId = rule.resolve(modelId);
      if (targetModelId && targetModelId !== modelId) {
        return {
          resolved: true,
          selection: {
            providerId,
            modelId: targetModelId,
            options: {
              ...options,
              ...(options?.reasoningLevel ? { reasoningLevel: "low" } : {})
            }
          },
          isConcrete: true
        };
      }
      return { resolved: true, selection: parentSelection, isConcrete: false };
    }
  }

  // 2. 未知/聚合源启发式转换
  const heuristicModelId = heuristicTransformModelId(modelId);
  if (heuristicModelId && heuristicModelId !== modelId) {
    return {
      resolved: true,
      selection: {
        providerId,
        modelId: heuristicModelId,
        options: {
          ...options,
          ...(options?.reasoningLevel ? { reasoningLevel: "low" } : {})
        }
      },
      isConcrete: true
    };
  }

  // 3. 终极安全原地兜底
  return {
    resolved: false,
    selection: parentSelection,
    isConcrete: false
  };
}

/**
 * 内存补丁逻辑：将源码字符串打上动态路由钩子
 */
function patchZCodeInMemory(code) {
  let patched = code;

  // 1. wit schema: 注入 tier 可选枚举
  const witTarget = 'run_in_background:V.boolean().optional().describe("Set to true to run this agent in the background. You will be notified when it completes.")})';
  if (patched.includes(witTarget)) {
    patched = patched.replace(
      witTarget,
      'run_in_background:V.boolean().optional().describe("Set to true to run this agent in the background. You will be notified when it completes."),tier:V.enum(["fast","standard","reasoning"]).optional().describe("Task tier: fast=lightweight exploration/reading/summary using provider flash/haiku/mini model; standard=normal development; reasoning=complex architecture")})'
    );
  }

  // 2. aIa handler: 透传 tier
  const aIaTarget = 'let i={sessionId:t.sessionId,turnId:t.turnId,parentToolCallId:t.toolCallId,agentType:o,description:n.description,prompt:n.prompt,';
  if (patched.includes(aIaTarget)) {
    patched = patched.replace(
      aIaTarget,
      'let i={sessionId:t.sessionId,turnId:t.turnId,parentToolCallId:t.toolCallId,agentType:o,description:n.description,prompt:n.prompt,tier:n.tier,'
    );
  }

  // 3. KNo: 透传 tier
  const kNoTarget = 'sessionId:n.childSessionId,description:t.description,maxTurns:n.profile.maxTurns,onSessionReady:f,permissionMode:n.profile.permissionMode,prompt:t.prompt,profile:n.profile,';
  if (patched.includes(kNoTarget)) {
    patched = patched.replace(
      kNoTarget,
      'sessionId:n.childSessionId,description:t.description,maxTurns:n.profile.maxTurns,onSessionReady:f,permissionMode:n.profile.permissionMode,prompt:t.prompt,profile:n.profile,tier:t.tier,'
    );
  }

  // 4. runExploreAgent 调用 m8o: 传入上下文
  const callM8oTarget = '{selection:u,hasConcreteModel:f}=m8o({profileSelection:t.profile.modelSelection,parentSelection:this.getSessionModelSelection(),overrideSelection:n?.modelOverride?.selection,resolveSelection:e.resolveEffectiveModelSelection})';
  if (patched.includes(callM8oTarget)) {
    patched = patched.replace(
      callM8oTarget,
      '{selection:u,hasConcreteModel:f}=m8o({profileSelection:t.profile.modelSelection,parentSelection:this.getSessionModelSelection(),overrideSelection:n?.modelOverride?.selection,resolveSelection:e.resolveEffectiveModelSelection,tier:t.tier,agentType:t.agentType,profile:t.profile})'
    );
  }

  // 5. m8o 定义: 引入全局全局暴露的路由决议器
  const m8oDefTarget = 'function m8o(e){let t=e.profileSelection,n=e.overrideSelection?{effectiveSelection:e.overrideSelection}:t?e.resolveSelection?e.resolveSelection(A0(t)):{effectiveSelection:t}:{effectiveSelection:e.parentSelection??null};';
  if (patched.includes(m8oDefTarget)) {
    patched = patched.replace(
      m8oDefTarget,
      'function m8o(e){let t=e.profileSelection;try{if(globalThis.__ZMOD_AGENT_ROUTER__){let _res=globalThis.__ZMOD_AGENT_ROUTER__.resolveSubagentTierSelection({parentSelection:e.parentSelection,tier:e.tier,agentType:e.agentType,profile:e.profile});if(_res&&_res.resolved&&_res.selection){return{hasConcreteModel:_res.isConcrete,selection:A0(_res.selection)}}}}catch(_err){}let n=e.overrideSelection?{effectiveSelection:e.overrideSelection}:t?e.resolveSelection?e.resolveSelection(A0(t)):{effectiveSelection:t}:{effectiveSelection:e.parentSelection??null};'
    );
  }

  return patched;
}

// 暴露到全局，供内存中的 m8o 随时调用
globalThis.__ZMOD_AGENT_ROUTER__ = {
  resolveSubagentTierSelection,
  KNOWN_TIER_RULES,
  heuristicTransformModelId
};

// =========================================================================
// Preload Hook 自执行守护：仅当目标进程为 zcode.cjs 时挂载 Module._compile
// =========================================================================
(function installHook() {
  const isAgentServer = process.argv.some(
    (arg) => typeof arg === "string" && arg.includes("zcode.cjs")
  );

  if (!isAgentServer) {
    return; // 非 zcode.cjs 进程，立即返回，零开销
  }

  try {
    const Module = require("module");
    const origCompile = Module.prototype._compile;

    Module.prototype._compile = function (content, filename) {
      if (filename && filename.includes("zcode.cjs")) {
        console.log(`[ZMod:AgentRouter] Applying in-memory tier patch to: ${filename}`);
        content = patchZCodeInMemory(content);
      }
      return origCompile.call(this, content, filename);
    };

    console.log(`[ZMod:AgentRouter] Preload hook active (PID: ${process.pid})`);
  } catch (err) {
    console.error("[ZMod:AgentRouter] Failed to install Module._compile hook:", err);
  }
})();

module.exports = {
  resolveSubagentTierSelection,
  KNOWN_TIER_RULES,
  heuristicTransformModelId,
  patchZCodeInMemory
};
