/**
 * ZMod Agent Dynamic Tier Router & In-Memory Preload Hook
 * 
 * smart-subagent 插件底层运行时。
 * 1. 作为 --require 模块预加载于 Node.js 进程链（Host 进程与 Agent 进程）；
 * 2. 具备自传播（Self-Propagating）能力：在 Host 进程中拦截 child_process.spawn，
 *    向启动 zcode.cjs 的命令行参数自动注入 ["-r", hookPath]，穿透宿主硬编码的 env 隔离；
 * 3. 当目标为 zcode.cjs 进程且 smart-subagent 插件开启时，在内存中动态完成模型分档热补丁；
 * 4. 物理磁盘上的 zcode.cjs 保持 100% 原版，零侵入、热插拔、受插件生命周期管控。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

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
      // Qwen3.8 系非 flash 命名（如 qwen3.8-max-0902）收敛到用户百炼渠道实际可用的轻量模型
      if (/3\.8/i.test(modelId)) return "qwen3.8-flash";
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
  // ZCode 官方 DeepSeek 通道的轻量档为 deepseek-flash（deepseek-chat 在该通道不存在）；
  // 开放平台旧名 V3 Chat 本就是轻量档，命中原样保留。
  {
    matcher: (providerId, modelId) => /deepseek/i.test(providerId) || /^deepseek-/i.test(modelId),
    resolve: (modelId) => {
      if (/flash/i.test(modelId)) return modelId;
      if (/v4.?pro/i.test(modelId) || /reasoner|r1/i.test(modelId)) return "deepseek-flash";
      if (/chat/i.test(modelId) || /v3/i.test(modelId)) return modelId;
      return "deepseek-flash";
    }
  }
];

/**
 * 获取 smart-subagent 插件配置
 */
function getPluginConfig() {
  try {
    const dataDir =
      process.env.ZMOD_USER_DATA_DIR ||
      (process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ZMod")
        : path.join(os.homedir(), ".config", "zmod"));

    // 候选顺序：
    // 1) 部署布局：本文件安装于 <data>/runtime/main/agent-router.cjs，向上两级即 <data>，
    //    直接命中 <data>/plugin-data/smart-subagent/config.json（与主进程 RPC 落盘位置一致）；
    // 2) 显式/推断数据目录（ZMOD_USER_DATA_DIR 由主进程 installAgentRouterHook 注入）；
    // 3) 历史开发布局兜底（repo 根 /data，仅旧版源码运行时可能命中）。
    const candidatePaths = [
      path.resolve(__dirname, "../../plugin-data/smart-subagent/config.json"),
      path.join(dataDir, "plugin-data", "smart-subagent", "config.json"),
      path.resolve(__dirname, "../../../../data/plugin-data/smart-subagent/config.json")
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      }
    }
  } catch {}
  return { enabled: true, exploreAutoFast: true, reduceThinking: true, customRules: {} };
}

/**
 * 未知源 / 聚合源的通用启发式模型名转换规则
 */
function heuristicTransformModelId(modelId) {
  if (!modelId || typeof modelId !== "string") return null;

  if (/flash|haiku|mini|turbo|lite|speed/i.test(modelId)) {
    return modelId;
  }

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

  const pluginCfg = getPluginConfig();
  if (pluginCfg && pluginCfg.enabled === false) {
    return { resolved: false, selection: parentSelection, isConcrete: false };
  }

  const isExplore = agentType === "Explore";
  const exploreAllowed = pluginCfg?.exploreAutoFast !== false;

  const isFastRequested =
    tier === "fast" ||
    profile?.tier === "fast" ||
    profile?.model === "auto-flash" ||
    profile?.model === "tier:fast" ||
    (isExplore && exploreAllowed);

  if (!isFastRequested) {
    return { resolved: false, selection: parentSelection, isConcrete: false };
  }

  const { providerId, modelId, options } = parentSelection;
  const reduceThinking = pluginCfg?.reduceThinking !== false;

  // 1. 用户自定义映射规则优先 (customRules)
  // 目标必须是非空字符串才采用，防止空串/非字符串值把子代理指到无效模型名
  const customMap = pluginCfg?.customRules || {};
  const customTarget = customMap[providerId] || customMap[modelId];
  if (typeof customTarget === "string" && customTarget.trim()) {
    const targetModelId = customTarget;
    return {
      resolved: true,
      selection: {
        providerId,
        modelId: targetModelId,
        options: {
          ...options,
          ...(reduceThinking && options?.reasoningLevel ? { reasoningLevel: "low" } : {})
        }
      },
      isConcrete: true
    };
  }

  // 2. 已知官方规则匹配
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
              ...(reduceThinking && options?.reasoningLevel ? { reasoningLevel: "low" } : {})
            }
          },
          isConcrete: true
        };
      }
      return { resolved: true, selection: parentSelection, isConcrete: false };
    }
  }

  // 3. 未知/聚合源启发式转换
  const heuristicModelId = heuristicTransformModelId(modelId);
  if (heuristicModelId && heuristicModelId !== modelId) {
    return {
      resolved: true,
      selection: {
        providerId,
        modelId: heuristicModelId,
        options: {
          ...options,
          ...(reduceThinking && options?.reasoningLevel ? { reasoningLevel: "low" } : {})
        }
      },
      isConcrete: true
    };
  }

  // 4. 终极安全原地兜底
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

  // 4. runExploreAgent 调用 m8o / $qo: 传入上下文
  const callM8oTarget = '{selection:u,hasConcreteModel:f}=m8o({profileSelection:t.profile.modelSelection,parentSelection:this.getSessionModelSelection(),overrideSelection:n?.modelOverride?.selection,resolveSelection:e.resolveEffectiveModelSelection})';
  if (patched.includes(callM8oTarget)) {
    patched = patched.replace(
      callM8oTarget,
      '{selection:u,hasConcreteModel:f}=m8o({profileSelection:t.profile.modelSelection,parentSelection:this.getSessionModelSelection(),overrideSelection:n?.modelOverride?.selection,resolveSelection:e.resolveEffectiveModelSelection,tier:t.tier,agentType:t.agentType,profile:t.profile})'
    );
  } else {
    patched = patched.replace(
      /\{selection:([a-zA-Z0-9_$]+),hasConcreteModel:([a-zA-Z0-9_$]+)\}=([a-zA-Z0-9_$]+)\(\{profileSelection:([a-zA-Z0-9_$]+)\.profile\.modelSelection,parentSelection:this\.getSessionModelSelection\(\),overrideSelection:([a-zA-Z0-9_$]+)\?\.modelOverride\?\.selection,resolveSelection:([a-zA-Z0-9_$]+)\.resolveEffectiveModelSelection\}\)/,
      '{selection:$1,hasConcreteModel:$2}=$3({profileSelection:$4.profile.modelSelection,parentSelection:this.getSessionModelSelection(),overrideSelection:$5?.modelOverride?.selection,resolveSelection:$6.resolveEffectiveModelSelection,tier:$4.tier,agentType:$4.agentType,profile:$4.profile})'
    );
  }

  // 5. m8o / $qo 定义: 引入全局暴露的路由决议器
  const m8oDefTarget = 'function m8o(e){let t=e.profileSelection,n=e.overrideSelection?{effectiveSelection:e.overrideSelection}:t?e.resolveSelection?e.resolveSelection(A0(t)):{effectiveSelection:t}:{effectiveSelection:e.parentSelection??null};';
  if (patched.includes(m8oDefTarget)) {
    patched = patched.replace(
      m8oDefTarget,
      'function m8o(e){let t=e.profileSelection;try{if(globalThis.__ZMOD_AGENT_ROUTER__){let _res=globalThis.__ZMOD_AGENT_ROUTER__.resolveSubagentTierSelection({parentSelection:e.parentSelection,tier:e.tier,agentType:e.agentType,profile:e.profile});if(_res&&_res.resolved&&_res.selection){return{hasConcreteModel:_res.isConcrete,selection:A0(_res.selection)}}}}catch(_err){}let n=e.overrideSelection?{effectiveSelection:e.overrideSelection}:t?e.resolveSelection?e.resolveSelection(A0(t)):{effectiveSelection:t}:{effectiveSelection:e.parentSelection??null};'
    );
  } else {
    patched = patched.replace(
      /function ([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+)\)\{let ([a-zA-Z0-9_$]+)=\2\.profileSelection,([a-zA-Z0-9_$]+)=\2\.overrideSelection\?\{effectiveSelection:\2\.overrideSelection\}:\3\?\2\.resolveSelection\?\2\.resolveSelection\(([a-zA-Z0-9_$]+)\(\3\)\):\{effectiveSelection:\3\}:\{effectiveSelection:\2\.parentSelection\?\?null\};/,
      'function $1($2){let $3=$2.profileSelection;try{if(globalThis.__ZMOD_AGENT_ROUTER__){let _res=globalThis.__ZMOD_AGENT_ROUTER__.resolveSubagentTierSelection({parentSelection:$2.parentSelection,tier:$2.tier,agentType:$2.agentType,profile:$2.profile});if(_res&&_res.resolved&&_res.selection){return{hasConcreteModel:_res.isConcrete,selection:$5(_res.selection)}}}}catch(_err){}let $4=$2.overrideSelection?{effectiveSelection:$2.overrideSelection}:$3?$2.resolveSelection?$2.resolveSelection($5($3)):{effectiveSelection:$3}:{effectiveSelection:$2.parentSelection??null};'
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
// 1. 子进程自传播守护：拦截当前进程的 child_process.spawn
// 解决宿主在 Host 进程启动 zcode.cjs 时硬编码 env: { ELECTRON_RUN_AS_NODE: "1" }
// 导致 NODE_OPTIONS 环境变量被清空丢弃的问题。
// =========================================================================
(function installSpawnPropagation() {
  try {
    const cp = require("node:child_process");
    if (!cp || typeof cp.spawn !== "function") return;

    const origSpawn = cp.spawn;
    const currentHookPath = path.resolve(__filename).replaceAll(path.sep, "/");

    cp.spawn = function (command, args, options) {
      if (Array.isArray(args)) {
        const zcodeIdx = args.findIndex(
          (a) => typeof a === "string" && a.includes("zcode.cjs")
        );
        // 如果是要启动 zcode.cjs，且尚未插入 -r 预加载参数
        if (zcodeIdx !== -1 && !args.includes("-r")) {
          args.splice(zcodeIdx, 0, "-r", currentHookPath);
        }
      }
      return origSpawn.call(this, command, args, options);
    };
  } catch (err) {
    // 忽略异常，降级运行
  }
})();

// =========================================================================
// 2. Preload Hook 内存热补丁：当目标进程编译 zcode.cjs 时触发
// =========================================================================
(function installCompileHook() {
  const isAgentServer = process.argv.some(
    (arg) => typeof arg === "string" && arg.includes("zcode.cjs")
  );

  if (!isAgentServer) {
    return;
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
