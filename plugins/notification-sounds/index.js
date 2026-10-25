import { definePlugin } from '@zmod/sdk';
import {
  EVENTS,
  CHANNELS,
  defaultSoundMap,
  resolveSound,
  shouldPlay,
  mergeLibrary,
  base64ToUint8Array
} from './lib.js';
import { mountCard } from './card.js';

const PLUGIN_ID = 'notification-sounds';
const OFFICIAL_POP_MARK = 'task-notification-pop';
const OFFICIAL_TASK_MARK = 'task-notification';

// readAsset 不可用时（如损坏的安装）的兜底内置音色，保证试听仍然可用
const FALLBACK_BUILTIN = [
  { id: 'builtin:pop', name: '弹跳 Pop', file: 'assets/pop.wav' },
  { id: 'builtin:ding', name: '清脆 Ding', file: 'assets/ding.wav' },
  { id: 'builtin:chime', name: '柔和风铃 Chime', file: 'assets/chime.wav' }
];

// definePlugin 的 actions 在 start 之前就定型，运行时句柄通过该槽位交接
let runtime = null;

export default definePlugin({
  // id/version 必须是字面量：manifest-consistency 测试按文本提取后与 manifest 对账
  id: 'notification-sounds',
  name: '通知声音管理',
  version: '0.1.0',
  description: '接管 ZCode 任务通知声音：音量调节、音色切换、导入自有音频、分事件配音、试听',
  author: 'ZMod Team',

  settings: {
    enabled: {
      type: 'switch',
      title: '接管通知声音',
      default: true
    },
    volume: {
      type: 'slider',
      title: '音量',
      description: '播放音量（百分比）',
      default: 70,
      min: 0,
      max: 100,
      step: 1
    },
    focusPlay: {
      type: 'switch',
      title: '窗口聚焦时也播放',
      description: '官方默认窗口聚焦时静音；开启后聚焦状态同样出声',
      default: false
    },
    preview: {
      type: 'action',
      title: '试听当前音色',
      action: 'preview'
    }
  },

  actions: {
    preview: {
      title: '试听当前音色',
      run: async () => {
        if (!runtime) return { ok: false, message: '插件尚未启动' };
        await runtime.preview();
        return { ok: true };
      }
    }
  },

  async start(ctx) {
    const { invoke, events, patcher, cleanup } = ctx;
    const s = ctx.settings;

    /* ---- 可变快照：热路径（每个通知）不碰 RPC，只读这里 ----
       soundMap 为非 schema 键：settings.set 对任意键都会写入 _activeSettings
       并经 config.setPluginSetting 持久化（无 schema 校验），onChange 同样按
       setting:<id>:<key> 触发，因此直接以对象形式存 'soundMap'。 */
    const snap = {
      enabled: s.get('enabled', true) !== false,
      volume: Number(s.get('volume', 70)) || 0,
      focusPlay: s.get('focusPlay', false) === true,
      soundMap: { ...defaultSoundMap(), ...(s.get('soundMap', {}) || {}) }
    };

    /* ---- 音频引擎：懒建 AudioContext + AudioBuffer 缓存 ---- */
    let audioCtx = null;
    const audioCache = new Map(); // soundId -> AudioBuffer
    const getAudioCtx = () => {
      if (!audioCtx) audioCtx = new AudioContext();
      return audioCtx;
    };

    /* ---- 音色库：builtin assets/index.json + plugin.listAssets 合并 ---- */
    let library = [];
    const reloadLibrary = async () => {
      let builtin = [];
      try {
        const res = await invoke('plugin.readAsset', {
          pluginId: PLUGIN_ID,
          relPath: 'assets/index.json',
          scope: 'plugin'
        });
        if (!res?.ok) throw new Error(res?.error || 'readAsset failed');
        builtin = JSON.parse(atob(res.base64)).sounds || [];
      } catch (err) {
        console.warn('[ZMod:NotifySounds] builtin index unavailable, using fallback:', err?.message || err);
        builtin = FALLBACK_BUILTIN;
      }
      let userAssets = [];
      try {
        const res = await invoke('plugin.listAssets', { pluginId: PLUGIN_ID });
        if (res?.ok) userAssets = res.assets || [];
      } catch (err) {
        console.warn('[ZMod:NotifySounds] listAssets failed:', err?.message || err);
      }
      library = mergeLibrary(builtin, userAssets);
      audioCache.clear();
      console.log(`[ZMod:NotifySounds] library ready: ${library.length} sound(s)`);
    };

    async function loadBuffer(entry) {
      let buf = audioCache.get(entry.id);
      if (buf) return buf;
      const res = await invoke('plugin.readAsset', {
        pluginId: PLUGIN_ID,
        relPath: entry.file,
        scope: entry.scope || 'plugin'
      });
      if (!res?.ok) throw new Error(res?.error || 'readAsset failed');
      const u8 = base64ToUint8Array(res.base64);
      // decodeAudioData 会接管整个 ArrayBuffer：长度不一致时切出精确副本
      let ab = u8.buffer;
      if (ab.byteLength !== u8.length) ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      buf = await getAudioCtx().decodeAudioData(ab);
      audioCache.set(entry.id, buf);
      return buf;
    }

    /** 失败只记日志，绝不抛出 —— 声音问题不能影响通知主流程 */
    async function playSound(soundId, volumePct) {
      try {
        if (!soundId) return;
        const entry = library.find((e) => e.id === soundId);
        if (!entry) {
          console.warn('[ZMod:NotifySounds] sound not in library:', soundId);
          return;
        }
        const actx = getAudioCtx();
        try {
          if (actx.state === 'suspended') await actx.resume();
        } catch {}
        const buf = await loadBuffer(entry);
        const src = actx.createBufferSource();
        src.buffer = buf;
        const gain = actx.createGain();
        gain.gain.value = Math.max(0, Math.min(1, (Number(volumePct) || 0) / 100));
        src.connect(gain).connect(actx.destination);
        src.start();
      } catch (err) {
        console.error('[ZMod:NotifySounds] play failed:', err?.message || err);
      }
    }

    const previewSound = () => playSound(snap.soundMap.default, snap.volume);

    await reloadLibrary();

    /* ---- B3 设置卡句柄：库重载完成后让其重绘（导入/删除后的最终态） ---- */
    let cardApi = null;

    /* ---- 库变更（B3 设置卡导入/删除音色后广播）→ 清缓存重合并 ---- */
    const offLib = events.on(CHANNELS.libraryChanged, async () => {
      try {
        await reloadLibrary();
      } catch (err) {
        console.error('[ZMod:NotifySounds] library reload failed:', err);
      }
      cardApi?.rerender?.();
    });
    cleanup(offLib);

    /* ---- 设置热更新：schema 键走 onChange；soundMap 非 schema 键同样会触发
       （settings.set 无条件 emit setting:<id>:<key>），再挂 settingsChanged
       总线事件兜底跨插件设置卡的场景 ---- */
    const refresh = (key) => {
      if (key === 'enabled') snap.enabled = s.get('enabled', true) !== false;
      else if (key === 'volume') snap.volume = Number(s.get('volume', 70)) || 0;
      else if (key === 'focusPlay') snap.focusPlay = s.get('focusPlay', false) === true;
      else if (key === 'soundMap') snap.soundMap = { ...defaultSoundMap(), ...(s.get('soundMap', {}) || {}) };
    };
    for (const key of ['enabled', 'volume', 'focusPlay', 'soundMap']) {
      cleanup(s.onChange(key, () => refresh(key)));
    }
    cleanup(
      events.on(CHANNELS.settingsChanged, () => {
        for (const key of ['enabled', 'volume', 'focusPlay', 'soundMap']) refresh(key);
      })
    );

    /* ---- B3 设置卡通道：试听 + soundMap 全量替换 ---- */
    cleanup(events.on(CHANNELS.preview, (soundId) => playSound(soundId, snap.volume)));
    cleanup(
      events.on(CHANNELS.mapChanged, (map) => {
        try {
          if (!map || typeof map !== 'object' || Array.isArray(map)) return;
          // 先合并回默认骨架再做类型收紧：只接受字符串值（'' = 跟随默认）
          const merged = { ...defaultSoundMap() };
          for (const key of Object.keys(merged)) {
            if (typeof map[key] === 'string') merged[key] = map[key];
          }
          // s.set 持久化并 emit setting:<id>:soundMap → 既有 onChange 链路刷新 snap
          s.set('soundMap', merged);
        } catch (err) {
          console.error('[ZMod:NotifySounds] mapChanged apply failed:', err);
        }
      })
    );

    /* ---- B3 设置卡：contribute 到官方设置页「扩展插件」区。
       内核在 plugins.loadAll() 之前就同步挂好 window.ZMod.settingsPage
       （renderer/index.js boot 时序），正常时序直接可用；轮询仅为兜底。 ---- */
    const wireCard = () => {
      const page = window.ZMod?.settingsPage;
      if (!page || typeof page.contribute !== 'function') return false;
      try {
        cardApi = mountCard({
          contribute: page.contribute.bind(page),
          uncontribute: typeof page.uncontribute === 'function' ? page.uncontribute.bind(page) : null,
          events,
          invoke,
          ui: ctx.ui,
          getLibrary: () => library,
          getSoundMap: () => snap.soundMap
        });
        cleanup(() => cardApi?.dispose?.());
        return true;
      } catch (err) {
        console.error('[ZMod:NotifySounds] card mount failed:', err);
        return true; // 挂载失败不重试，避免刷错误日志
      }
    };
    if (!wireCard()) {
      let tries = 0;
      const poll = setInterval(() => {
        if (wireCard() || ++tries >= 20) clearInterval(poll);
      }, 500);
      cleanup(() => clearInterval(poll));
    }
    // 兜底：插件停用（含热更新重载）时务必把卡片从设置页撤下
    cleanup(() => {
      try {
        window.ZMod?.settingsPage?.uncontribute?.(PLUGIN_ID);
      } catch {}
    });

    /* ---- 官方通知声压制补丁：instead 回调首参为绑定原函数，返回值即结果 ---- */
    const warnedSrcs = new Set();
    patcher.instead(HTMLAudioElement.prototype, 'play', function (orig) {
      const src = String(this.currentSrc || this.src || '');
      if (src.includes(OFFICIAL_POP_MARK)) return Promise.resolve();
      if (src.includes(OFFICIAL_TASK_MARK) && !warnedSrcs.has(src)) {
        // 官方通知声家族出现新成员（漂移检测）：放行并提醒一次
        warnedSrcs.add(src);
        console.warn('[ZMod:NotifySounds] unhandled official notification sound passing through:', src);
      }
      return orig();
    });

    /* ---- 通知事件：主进程 tap 经 preload 桥 sender 定向转发 ---- */
    const seen = new Map(); // dedupeKey -> first-seen ts
    const onNotification = (evt) => {
      try {
        if (!evt || typeof evt !== 'object') return;
        if (!snap.enabled) return;
        if (evt.anyFocused && !snap.focusPlay) return;
        if (!shouldPlay(evt, seen, Date.now())) return;
        playSound(resolveSound(snap.soundMap, evt.status), snap.volume);
      } catch (err) {
        console.error('[ZMod:NotifySounds] notification handler error:', err);
      }
    };
    const bridge = typeof window !== 'undefined' ? window.zmodAPI : null;
    if (bridge && typeof bridge.on === 'function') {
      cleanup(bridge.on('zmod:notification-event', onNotification));
    } else {
      console.warn('[ZMod:NotifySounds] preload bridge unavailable — no notification sounds');
    }

    cleanup(() => {
      try {
        audioCtx?.close?.().catch?.(() => {});
      } catch {}
      audioCtx = null;
      audioCache.clear();
      runtime = null;
    });

    runtime = { preview: previewSound };
    console.log(`[ZMod:NotifySounds] armed (events: ${EVENTS.map((e) => e.status).join(', ')})`);
  },

  async stop() {
    /* teardown handled via ctx.cleanup */
  }
});
