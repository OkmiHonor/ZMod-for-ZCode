import { definePlugin } from '@zmod/sdk';
import {
  matchGateway,
  checkGatewayAlive,
  canLaunch,
  recordLaunch,
  extractModelFromDomText
} from './lib.js';

export default definePlugin({
  id: 'gateway-keeper',
  name: '反代网关守护',
  description: '智能感知当前会话模型，按需自动探活并拉起本地反代网关（Antigravity Tools、Magpie 等），告别手动点开',
  version: '1.0.0',
  author: 'ZMod Team',

  settings: {
    antigravityGroup: {
      type: 'group',
      title: 'Antigravity Tools (Google AI Pro 等)'
    },
    antigravityEnabled: {
      type: 'switch',
      title: '启用 Antigravity Tools 自动拉起',
      default: true
    },
    antigravityPath: {
      type: 'text',
      title: '可执行文件完整路径',
      default: 'D:\\Antigravity Tools\\antigravity-tools.exe'
    },
    antigravityUrl: {
      type: 'text',
      title: '探活服务地址',
      default: 'http://127.0.0.1:8045'
    },
    antigravityKeywords: {
      type: 'text',
      title: '触发模型关键词',
      default: 'gemini, claude-opus, claude-sonnet-5, gpt-oss, google'
    },
    magpieGroup: {
      type: 'group',
      title: 'Magpie 网关'
    },
    magpieEnabled: {
      type: 'switch',
      title: '启用 Magpie 自动拉起',
      default: false
    },
    magpiePath: {
      type: 'text',
      title: '可执行文件完整路径',
      default: 'C:\\Users\\YOUR_USERNAME\\AppData\\Local\\Programs\\magpie\\magpie.exe'
    },
    magpieUrl: {
      type: 'text',
      title: '探活服务地址',
      default: 'http://127.0.0.1:3425'
    },
    magpieKeywords: {
      type: 'text',
      title: '触发模型关键词',
      default: 'magpie, zcode/'
    },
    behaviorGroup: {
      type: 'group',
      title: '守护行为与提示'
    },
    autoToast: {
      type: 'switch',
      title: '拉起时显示状态提示',
      default: true
    },
    cooldownSeconds: {
      type: 'number',
      title: '启动防抖冷却时间 (秒)',
      default: 15
    }
  },

  start(ctx) {
    const { settings: s, invoke, ui, cleanup } = ctx;
    const lastLaunchMap = {};
    let inFlightCheck = false;
    let debounceTimer = null;

    function getGateways() {
      return [
        {
          id: 'antigravity-tools',
          name: 'Antigravity Tools',
          enabled: s.get('antigravityEnabled', true) === true,
          path: s.get('antigravityPath', 'D:\\Antigravity Tools\\antigravity-tools.exe'),
          url: s.get('antigravityUrl', 'http://127.0.0.1:8045'),
          keywords: s.get('antigravityKeywords', 'gemini, claude-opus, claude-sonnet-5, gpt-oss, google')
        },
        {
          id: 'magpie',
          name: 'Magpie',
          enabled: s.get('magpieEnabled', false) === true,
          path: s.get('magpiePath', 'C:\\Users\\YOUR_USERNAME\\AppData\\Local\\Programs\\magpie\\magpie.exe'),
          url: s.get('magpieUrl', 'http://127.0.0.1:3425'),
          keywords: s.get('magpieKeywords', 'magpie, zcode/')
        }
      ];
    }

    async function checkAndWake() {
      if (inFlightCheck) return;
      if (typeof document === 'undefined') return;

      const triggerEl = document.querySelector('[data-testid="chat-model-select-trigger"]');
      if (!triggerEl) return;

      const modelName = extractModelFromDomText(triggerEl.textContent || '');
      if (!modelName) return;

      const gateways = getGateways();
      const gw = matchGateway(modelName, gateways);
      if (!gw) return;

      const cooldownSeconds = Number(s.get('cooldownSeconds', 15)) || 15;
      const cooldownMs = Math.max(1, cooldownSeconds) * 1000;
      if (!canLaunch(gw.id, lastLaunchMap, cooldownMs)) return;

      inFlightCheck = true;
      try {
        const aliveRes = await checkGatewayAlive(gw.url, (p) => invoke('net.fetch', p), 1200);
        if (aliveRes.alive) {
          return;
        }

        // 双重冷却检查：防止探活网络等待期间其他调用已触发拉起
        if (!canLaunch(gw.id, lastLaunchMap, cooldownMs)) return;
        recordLaunch(gw.id, lastLaunchMap);

        const autoToast = s.get('autoToast', true) !== false;
        if (autoToast) {
          ui?.showToast?.(`检测到反代模型「${modelName}」，正在后台唤起 ${gw.name}...`, 'info');
        }

        const launchRes = await invoke('system.launchApp', { execPath: gw.path });
        if (launchRes && launchRes.ok === false) {
          ui?.showToast?.(`唤起 ${gw.name} 失败: ${launchRes.error || '未知错误'}`, 'warn');
        }
      } catch (err) {
        // 静默异常防御
      } finally {
        inFlightCheck = false;
      }
    }

    function scheduleCheck(delayMs = 300) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        checkAndWake().catch(() => {});
      }, delayMs);
    }

    // 1. 监听全局点击（如切换会话、切换工作区等场景）
    if (typeof document !== 'undefined') {
      const handleClick = () => {
        scheduleCheck(350);
      };
      document.addEventListener('click', handleClick, true);
      cleanup(() => document.removeEventListener('click', handleClick, true));

      // 2. 观察 DOM 变动（切换会话渲染、模型选择器内容变动）
      const targetNode = document.body || document.documentElement;
      if (targetNode && typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(() => {
          scheduleCheck(300);
        });
        observer.observe(targetNode, {
          childList: true,
          subtree: true,
          characterData: true
        });
        cleanup(() => observer.disconnect());
      }
    }

    // 3. 注册清理定时器
    cleanup(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    });

    // 4. 启动后延迟执行初始检查
    scheduleCheck(500);
  }
});
