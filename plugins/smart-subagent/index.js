import { definePlugin } from '@zmod/sdk';

export default definePlugin({
  id: 'smart-subagent',
  name: '子代理智能模型路由',
  description: '自动感知当前会话订阅源，派发子代理时动态降级选用同源 Flash/Haiku/Mini/Turbo 轻量模型',
  version: '1.0.1',
  author: 'ZMod Team',

  settings: {
    enableRouter: {
      type: 'switch',
      title: '启用智能模型分档与降级',
      description: '派发子代理或探路任务时，自动路由到当前订阅源对应的 Flash/轻量模型，避免消耗昂贵的旗舰/深度思考模型',
      default: true
    },
    exploreAutoFast: {
      type: 'switch',
      title: '探路子代理 (Explore) 强制极速',
      description: '代码检索、查阅文件等只读探路子代理（Explore）默认自动采用同源 Flash 级别模型',
      default: true
    },
    reduceThinking: {
      type: 'switch',
      title: '调低子代理思考深度',
      description: '子代理执行任务时将 reasoningLevel 自动下调为 low，进一步缩短延迟并节约思考 Token',
      default: true
    },
    customRules: {
      type: 'text',
      title: '自定义 Provider 映射 (JSON)',
      description: '针对企业私有中转、聚合网关的专属映射字典，如 {"my-gateway": "qwen2.5-7b-speed"}',
      default: '{}'
    },
    groupRules: {
      type: 'group',
      title: '内置已支持的主流官方通道：Google Gemini (Pro→Flash) · Claude (Sonnet/Opus→Haiku) · OpenAI (GPT-4o→Mini) · 阿里百炼 (Qwen3.8 Max→Qwen3.8 Flash, Max/Plus→Turbo) · 智谱GLM (GLM-5→Flash) · DeepSeek (V4 Pro/R1→DeepSeek Flash)'
    }
  },

  async start(ctx) {
    const { settings: s, invoke, ui: u } = ctx;

    const syncToHost = async () => {
      let custom = {};
      try {
        const raw = s.get('customRules', '{}');
        if (raw && typeof raw === 'string') {
          custom = JSON.parse(raw);
        }
      } catch (err) {
        u?.showToast?.('自定义 Provider 映射 JSON 格式有误', 'warn');
      }

      const payload = {
        enabled: s.get('enableRouter', true),
        exploreAutoFast: s.get('exploreAutoFast', true),
        reduceThinking: s.get('reduceThinking', true),
        customRules: custom
      };

      try {
        await invoke('subagentRouter.syncConfig', payload);
      } catch (err) {
        console.warn('[ZMod:SmartSubagent] host sync warning:', err?.message || err);
      }
    };

    await syncToHost();

    ctx.cleanup(() => {
      invoke('subagentRouter.syncConfig', { enabled: false }).catch(() => {});
    });

    s.onChange('enableRouter', syncToHost);
    s.onChange('exploreAutoFast', syncToHost);
    s.onChange('reduceThinking', syncToHost);
    s.onChange('customRules', syncToHost);
  },

  async stop() {
    /* cleanup handles teardown */
  }
});
