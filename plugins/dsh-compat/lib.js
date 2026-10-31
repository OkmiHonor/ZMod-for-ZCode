/**
 * dsh-compat 纯逻辑层：DSH（DeepSeek Harness）插件契约的零依赖实现。
 * 零 DOM / 零 SDK 依赖，node --test 可直接驱动；DOM/React 装配在 index.js。
 *
 * DSH 插件契约（逆向自 dsh-pet 源码，已核实）：
 * 1. 客户端半侧是普通副作用脚本，加载时调用
 *    window.__ModuleLoader__.load({ id, factory })，factory = (require) => module；
 * 2. factory 返回 Cordis 风格三件套 { name, inject, apply(ctx) }：
 *    inject 是服务名字符串数组，服务以同名属性挂在 ctx 上。
 */

// ---- jsx 垫片 ----------------------------------------------------------------
// React 18 UMD 不带 react/jsx-runtime，而 DSH 插件构建产物（tsdown/esbuild 按
// JSX runtime 自动选择）会 require('react/jsx-runtime')。这里手写等价实现。

const REACT_ELEMENT = Symbol.for('react.element');

/**
 * jsx(type, config, maybeKey)：与官方 react/jsx-runtime 语义对齐 ——
 * key 取 maybeKey ?? config.key ?? null；ref 取 config.ref ?? null（不进 props）；
 * props 是 config 的浅拷贝（children 就是个普通 prop，不单列）。
 */
export function jsx(type, config, maybeKey) {
  const props = {};
  if (config != null) {
    for (const k of Object.keys(config)) {
      if (k === 'key' || k === 'ref') continue;
      props[k] = config[k];
    }
  }
  return {
    $$typeof: REACT_ELEMENT,
    type,
    key: maybeKey ?? config?.key ?? null,
    ref: config?.ref ?? null,
    props,
    _owner: null
  };
}

export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = Symbol.for('react.fragment');

/** The require-table entry served for 'react/jsx-runtime' / 'react/jsx-dev-runtime'. */
export function makeJsxShim() {
  return { jsx, jsxs, jsxDEV, Fragment };
}

// ---- 包发现 ------------------------------------------------------------------

function stripDotSlash(p) {
  const s = String(p);
  return s.startsWith('./') ? s.slice(2) : s;
}

/**
 * 筛出"可装载"的 DSH 包。
 * @param {Array<{name:string,type:'file'|'dir',size?:number,mtimeMs?:number}>} entries
 *   plugin.listDir 返回的目录条目（只认 dir）
 * @param {Object<string, object|null>} manifests dirName → 解析后的 package.json
 *   （读取/解析失败为 null）
 * @returns {Array<{name, loadable:true, clientPath:string|null, version:string, displayName:string}
 *              |{name, loadable:false, reason:string}>}
 *   可装载判定：exports['./client']（字符串或 { default } 取 default 路径）或存在
 *   dsh.client 字段；纯宿主半侧包（两者皆无）过滤掉并标注 skip 原因。
 *   仅有 dsh.client 而无 exports 路径时 loadable=true 但 clientPath=null，
 *   由装载阶段跳过（没有可注入的脚本 URL）。
 */
export function filterLoadablePackages(entries, manifests) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.type !== 'dir') continue;
    const name = entry.name;
    const pkg = manifests ? manifests[name] : undefined;
    if (pkg == null || typeof pkg !== 'object') {
      out.push({ name, loadable: false, reason: 'no-package-json' });
      continue;
    }
    const exp = pkg.exports ? pkg.exports['./client'] : undefined;
    let clientPath = null;
    if (typeof exp === 'string') clientPath = stripDotSlash(exp);
    else if (exp && typeof exp === 'object' && typeof exp.default === 'string') {
      clientPath = stripDotSlash(exp.default);
    }
    const hasDshClient = !!(pkg.dsh && typeof pkg.dsh === 'object' && pkg.dsh.client != null);
    if (!clientPath && !hasDshClient) {
      out.push({ name, loadable: false, reason: 'no-client-entry' });
      continue;
    }
    out.push({
      name,
      dirName: entry.name,
      loadable: true,
      clientPath,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      displayName: typeof pkg.name === 'string' ? pkg.name : name
    });
  }
  return out;
}

// ---- require 表 ---------------------------------------------------------------

/**
 * DSH 客户端 UI Primitives 基础垫片（供 dshmarket / dsh-pet 等依赖 @deepseek-ai/dsh-client-ui-primitives 的插件使用）
 */
export function createUiPrimitivesStub(React) {
  const DummyComponent = ({ children, text, label, ...props } = {}) => {
    if (!React || !React.createElement) return null;
    return React.createElement(
      'div',
      { className: 'dsh-primitive-stub', ...props },
      text || label || children || null
    );
  };
  const DummyIcon = () => null;

  const primitives = {
    Menu: DummyComponent,
    DisclosureRow: DummyComponent,
    Tooltip: ({ children } = {}) => children || null,
    Toast: DummyComponent,
    Tag: DummyComponent,
    Switch: ({ checked, onChange } = {}) =>
      React && React.createElement
        ? React.createElement('input', {
            type: 'checkbox',
            checked: Boolean(checked),
            onChange: (e) => onChange?.(e.target.checked)
          })
        : null,
    Checkbox: ({ checked, onChange } = {}) =>
      React && React.createElement
        ? React.createElement('input', {
            type: 'checkbox',
            checked: Boolean(checked),
            onChange: (e) => onChange?.(e.target.checked)
          })
        : null,
    Button: DummyComponent,
    Input: (props) => (React && React.createElement ? React.createElement('input', props) : null),
    // dshmarket 直接访问（非 optionalComponent 容错路径）的其余 primitives——
    // 经 esbuild __toESM 包装后只剩静态自有属性，缺一个就是 React error #130
    Modal: ({ open, onClose, children } = {}) =>
      !open || !React || !React.createElement
        ? null
        : React.createElement(
            'div',
            {
              'data-dsh-modal': 'true',
              onClick: (e) => {
                if (e.target?.dataset?.dshModal) onClose?.();
              }
            },
            children || null
          ),
    StateDot: DummyComponent,
    Pill: DummyComponent
  };

  return new Proxy(primitives, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('Icon')) return DummyIcon;
      if (prop === '__esModule') return true;
      if (prop === 'default') return target;
      return DummyComponent;
    }
  });
}

/**
 * 构造 DSH factory 用的同步 require(modName)：
 * react 系种子模块映射到本插件的 vendor UMD 全局与 jsx 垫片，其余查 stubs 表。
 * 未命中直接 throw —— 与 DSH 宿主一致，让插件自己的降级逻辑（try/catch）接管。
 * @param {object} React window.React（UMD 全局）
 * @param {object} ReactDOM window.ReactDOM（UMD 全局）
 * @param {Object<string, unknown>} stubs 平台种子模块兜底表
 */
export function buildRequireTable(React, ReactDOM, stubs = {}) {
  const primitivesStub = createUiPrimitivesStub(React);
  const table = new Map([
    ['react', React],
    ['react/jsx-runtime', makeJsxShim()],
    ['react/jsx-dev-runtime', makeJsxShim()],
    ['react-dom', ReactDOM],
    [
      'react-dom/client',
      { createRoot: ReactDOM?.createRoot, hydrateRoot: ReactDOM?.hydrateRoot }
    ],
    ['@deepseek-ai/dsh-client-ui-primitives', primitivesStub]
  ]);
  return function require(modName) {
    if (Object.prototype.hasOwnProperty.call(stubs, modName)) return stubs[modName];
    if (table.has(modName)) return table.get(modName);
    throw new Error(`[dsh-compat] 未提供的模块: ${modName}`);
  };
}

// ---- Cordis 风格 ctx ----------------------------------------------------------

/**
 * 构造 DSH 插件的 Cordis 风格 ctx 骨架。
 * @param {Object<string, unknown>} services provide 写入的目标袋（可传入共享对象观察）
 * @param {Array<Function>} cleanups effect 登记的清理回调（停用时由调用方 LIFO 执行）
 * @returns {{ effect, provide, get, on, emit }} 服务注入不在此处：调用方按 inject 清单
 *   把 stub 以同名属性 Object.assign 到返回对象上。
 */
export function createDshContext(services = {}, cleanups = []) {
  const bus = new Map();
  return {
    /** Cordis effect：立即执行 fn，返回值若为函数则登记为清理回调。 */
    effect(fn, label) {
      const ret = typeof fn === 'function' ? fn() : undefined;
      if (typeof ret === 'function') cleanups.push(ret);
      return ret;
    },
    /** 向同页其他插件提供 Cordis 服务。 */
    provide(key, value) {
      services[key] = value;
    },
    /** Cordis get：读取服务袋（ctx.get?.('x') 调用方探测惯例）。 */
    get(key) {
      return services[key];
    },
    /** Cordis inject：根据依赖注入作用域执行回调 */
    inject(deps, callback) {
      if (typeof callback === 'function') {
        const scoped = Object.create(this);
        for (const dep of deps || []) {
          if (!scoped[dep]) scoped[dep] = services[dep] || {};
        }
        try {
          callback(scoped);
        } catch (e) {
          console.warn('[dsh-compat] ctx.inject callback error:', e);
        }
      }
    },
    on(event, handler) {
      if (!bus.has(event)) bus.set(event, new Set());
      bus.get(event).add(handler);
      return () => bus.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      const handlers = bus.get(event);
      if (handlers) {
        for (const h of handlers) {
          try { h(...args); } catch {}
        }
      }
    }
  };
}

// ---- DSH 基础响应式服务（layout / locale / theme） ---------------------------

/**
 * 构造 DSH layout 响应式布局服务（支持 panelInfo.getSnapshot 与 selectPanel）。
 */
export function createLayoutService(initialPanelId = null) {
  let activePanelId = initialPanelId;
  // useSyncExternalStore 契约：getSnapshot 必须返回稳定引用（Object.is 比较），
  // 每次都返回新对象会让 React 判定 store 永远在变化 → 无限重渲染 → React error #185
  let snapshot = { activePanelId };
  const listeners = new Set();
  const notify = () => {
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
  };
  return {
    panelInfo: {
      getSnapshot() {
        return snapshot;
      },
      subscribe(listener) {
        if (typeof listener === 'function') listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    selectPanel(id) {
      if (activePanelId === id) return;
      activePanelId = id;
      snapshot = { activePanelId };
      notify();
    },
    getActivePanelId() {
      return activePanelId;
    }
  };
}

/**
 * 构造 DSH locale 响应式多语言服务（支持 useSyncExternalStore 快照与绑定翻译）。
 */
export function createLocaleService(defaultLang = 'zh') {
  const dicts = new Map();
  let active = defaultLang;
  // useSyncExternalStore 契约：getSnapshot 必须返回稳定引用（Object.is 比较），
  // 每次都返回新对象会让 React 判定 store 永远在变化 → 无限重渲染 → React error #185
  let snapshot = { active };
  const listeners = new Set();
  const notify = () => {
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
  };
  const readPath = (table, key) => {
    let cur = table;
    for (const part of String(key).split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return typeof cur === 'string' ? cur : undefined;
  };
  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      if (typeof listener === 'function') listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLanguage(lang) {
      if (active === lang) return;
      active = lang;
      snapshot = { active };
      notify();
    },
    register(ns, dict) {
      dicts.set(ns, dict && typeof dict === 'object' ? dict : {});
      notify();
    },
    bind(ns) {
      return function t(key, params) {
        const dict = dicts.get(ns) || {};
        const lang = String(active || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
        let str = readPath(dict[lang], key) ?? readPath(dict.zh, key) ?? readPath(dict.en, key) ?? key;
        if (params && typeof str === 'string') {
          str = str.replace(/\{(\w+)\}/g, (m, k) =>
            Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
          );
        }
        return str;
      };
    }
  };
}

/**
 * 构造 DSH theme 响应式主题服务。
 */
/**
 * 构造 DSH theme 响应式主题服务。
 *
 * getTheme() 契约（dshmarket 消费端实测）：返回宿主主题注册表快照对象
 * `{ preference, themes: [{ id, colorScheme, tokens }] }`，宿主无主题注册表时返回
 * **null**（dshmarket 以 `themeSnap !== null` 门控整个「主题」页签，null = 完整降级）。
 * **绝不能返回字符串**——`themeSnap.themes` 会是 undefined → `.filter` 崩溃（error #185 教训
 * 同源：useSyncExternalStore 快照必须稳定引用）。
 */
export function createThemeService(defaultTheme = 'dark') {
  let preference = defaultTheme;
  let snapshot = null; // ZMod 无 DSH 主题注册表 → null 诚实降级，「主题」页签自动隐藏
  const listeners = new Set();
  const notify = () => {
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
  };
  return {
    getTheme: () => snapshot,
    setTheme: (next) => {
      const id = typeof next === 'string' ? next : next?.id;
      if (!id || id === preference) return;
      preference = id;
      notify();
    },
    on: (evt, cb) => {
      if (evt === 'theme/change' && typeof cb === 'function') {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }
      return () => {};
    },
    subscribe: (cb) => {
      if (typeof cb === 'function') listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: () => snapshot
  };
}

// ---- 槽位排序 ------------------------------------------------------------------

/**
 * 按 meta.order 升序稳定排序（order 缺省按 0）。
 * @param {Array<{meta:{order?:number}, render:Function}>} registrations
 */
export function sortSlots(registrations) {
  return (registrations || [])
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const oa = a.item?.meta?.order ?? 0;
      const ob = b.item?.meta?.order ?? 0;
      return oa - ob || a.idx - b.idx;
    })
    .map((w) => w.item);
}

// ---- DSH 插件包名解析与元数据查询 ------------------------------------------------

export const DEFAULT_REGISTRIES = {
  npmmirror: { name: 'npmmirror (中国大陆镜像)', url: 'https://registry.npmmirror.com' },
  npmjs: { name: 'npm 官方源', url: 'https://registry.npmjs.org' }
};

/**
 * 解析用户输入的安装规范（包名、带版本、或 direct tarball URL）。
 * @param {string} raw 用户输入字符串
 * @returns {{ isUrl: boolean, name: string, version: string, url?: string } | null}
 */
export function parsePackageSpec(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return null;

  if (/^https?:\/\//i.test(str)) {
    // direct URL 形态：支持 .tgz / .tar.gz / .zip 或 npm registry 直链
    let name = '';
    const matchPkg = str.match(/\/(@?[a-zA-Z0-9_.-]+)\/-\/\1-[0-9a-zA-Z_.-]+\.tgz/);
    if (matchPkg) {
      name = matchPkg[1];
    } else {
      const slash = str.lastIndexOf('/');
      const base = slash >= 0 ? str.slice(slash + 1).split('?')[0].split('#')[0] : 'pkg';
      name = base.replace(/(\.tgz|\.tar\.gz|\.zip)$/i, '').replace(/-[0-9]+\.[0-9].*$/, '') || 'pkg';
    }
    return { isUrl: true, name, version: '', url: str };
  }

  // npm spec：支持 scoped 包名如 @deepseek-ai/dsh-pet@0.3.8 或普通包名 dsh-pet
  const m = str.match(/^(@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)(?:@([^/\s]+))?$/);
  if (!m) return null;
  return {
    isUrl: false,
    name: m[1],
    version: m[2] || 'latest'
  };
}

/**
 * 从 registry 查询包元数据，提取真实下载 tarball URL 与描述。
 * @param {{ isUrl: boolean, name: string, version: string, url?: string }} spec
 * @param {string} registryBase 注册表基础 URL
 * @param {Function} fetchImpl fetch 函数（便于单测 mock）
 */
export async function resolvePackageMeta(spec, registryBase, fetchImpl = globalThis.fetch) {
  if (!spec) throw new Error('无效的包规范');
  if (spec.isUrl) {
    return {
      name: spec.name || 'pkg',
      version: spec.version || '',
      tarballUrl: spec.url,
      description: '自定义链接来源包',
      hasClient: true
    };
  }

  const base = String(registryBase || DEFAULT_REGISTRIES.npmmirror.url).replace(/\/+$/, '');
  const encodedName = spec.name.startsWith('@')
    ? '@' + encodeURIComponent(spec.name.slice(1))
    : encodeURIComponent(spec.name);
  const infoUrl = `${base}/${encodedName}`;

  const res = await fetchImpl(infoUrl);
  if (!res.ok) {
    throw new Error(`在注册表未能找到包 ${spec.name} (HTTP ${res.status})`);
  }

  const data = await res.json();
  const versions = data.versions || {};
  let targetVer = spec.version;
  if (!targetVer || targetVer === 'latest') {
    targetVer = data['dist-tags']?.latest || Object.keys(versions).pop();
  }
  const verData = versions[targetVer];
  if (!verData) {
    throw new Error(`包 ${spec.name} 不存在版本 ${targetVer}`);
  }

  const tarballUrl = verData.dist?.tarball;
  if (!tarballUrl) {
    throw new Error(`版本 ${targetVer} 缺少 tarball 下载链接`);
  }

  const hasClient = Boolean(
    verData.exports?.['./client'] || (verData.dsh && verData.dsh.client)
  );

  return {
    name: verData.name || spec.name,
    version: targetVer,
    tarballUrl,
    description: verData.description || data.description || '',
    hasClient
  };
}

// ---- DSH 本地资源 URL 重映射与默认桌宠配置 ---------------------------------------

export const DEFAULT_PET_CONFIG = {
  whisperPrompt: "你是主人桌面上的Q版蓝发小女仆，会时不时碎碎念一句。说话要自然随意、短短一句（20字以内），温柔乖巧带点俏皮，说人话不啰嗦，不要解释你自己，不要提你是AI。",
  chatMemoryRounds: 5,
  whisperModel: { provider: "", model: "" },
  chatModel: { provider: "", model: "" },
  whisperImageEnabled: true,
  chatImageEnabled: true,
  chatImageLimit: 10,
  notificationsEnabled: true,
  confineToScreen: false,
  physics: {
    gravity: 1400,
    bounce: 0.3,
    restitution: 0.78,
    groundFriction: 2.5,
    ceilingBounce: true,
    throwPower: 1,
    petCollision: false
  },
  font: {
    family: "candy",
    size: 21,
    followPet: true
  },
  pets: [
    {
      name: "蓝毛小女仆",
      id: "main",
      size: 462,
      balanceEnabled: true,
      whisperEnabled: true,
      workStatusEnabled: true,
      fixedEnabled: false,
      display: "both",
      position: { corner: "top-right", marginX: 24, marginY: 100 }
    }
  ],
  animations: {
    idle: ["待机呼吸休闲"],
    turn: ["东张西望"],
    drag: ["被鼠标拖拽悬空反馈"],
    clicks: [
      "点击回应-开心跃动",
      "点击回应-害羞惊讶",
      "点击回应-傲娇生气",
      "点击回应-挠痒咯咯笑",
      "点击回应-元气挥手"
    ],
    moves: {
      default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 },
      actions: [
        { name: "螃蟹走路" },
        { name: "原地漂浮踏步", params: { minDist: 40, maxDist: 120 } },
        { name: "原地左转奔跑", params: { minDist: 120, maxDist: 320, leadSec: 1.75, tailSec: 4.8 } }
      ]
    },
    categories: [
      {
        id: "小动作",
        weight: 20,
        actions: [
          "悠闲哼歌", "超大伸懒腰", "原地敲击桌面互动", "原地重力下蹲压缩", "哈欠连天",
          "原地小憩沉眠", "女仆屈膝礼仪", "被吓一跳", "小幅度原地360度旋转展示",
          "偷吃零食被抓住", "用鲸鱼尾巴拍打地面", "打瞌睡被惊醒", "照镜子",
          "整体换装试色", "轻快记录", "写代码", "摇扇纳凉", "晨间刷牙"
        ]
      },
      {
        id: "玩耍",
        weight: 20,
        actions: [
          "原地专心玩魔方", "原地蹲下玩玩具汽车", "鲸鱼吐泡泡特效", "原地跳跃抓碎头顶物品",
          "玩游戏气急败坏", "玩水枪", "小提琴演奏", "蓝鲸现世", "优雅女仆舞",
          "轻快摇摆舞", "可爱宅舞", "吹气球", "动物环绕", "放风筝", "拆礼物",
          "变鸽子", "扑克魔术", "抽陀螺", "吹笛子", "蝴蝶蜜蜂环绕头顶开花",
          "撸猫", "凭空生花", "骑木马", "三球抛接", "踢毽子", "下五子棋", "荡秋千"
        ]
      },
      {
        id: "吃什么",
        weight: 16,
        actions: [
          "吃白饭", "大口吃零食", "吃Token", "吃早餐", "吃午餐", "吃晚餐",
          "吃冰淇淋融化", "吃大闸蟹", "吃糖葫芦", "吃长寿面", "吃西瓜", "涮火锅"
        ]
      },
      {
        id: "时节",
        weight: 14,
        actions: [
          "被落叶淹没", "中秋赏月吃月饼", "堆雪人", "放烟花", "吃粽子", "吃年糕",
          "吃青团", "吃腊八粥", "吃重阳糕", "收红包", "写福字", "穿针乞巧",
          "舞狮头", "讨糖南瓜灯", "插茱萸赏菊", "放河灯", "萌化小幽灵",
          "装点圣诞树", "放孔明灯", "吃汤圆", "吃饺子"
        ]
      },
      {
        id: "文字",
        weight: 10,
        noMirror: true,
        actions: ["是啊，吃什么", "深度思考碎碎念"]
      }
    ],
    events: {
      balance: [
        "余额-钱袋满溢", "余额-金袋叮当", "余额-钱袋如常",
        "余额-数金皱眉", "余额-袋空如洗", "余额-分文不剩"
      ],
      whisper: [
        "碎碎念-擦桌碎碎念", "碎碎念-发呆碎碎念", "碎碎念-对屏碎碎念"
      ],
      workStatus: [
        "工作状态-思考冒泡", "工作状态-忙碌点按", "工作状态-清点归档",
        "工作状态-原地踱步张望", "工作状态-雀跃庆祝", "工作状态-垂头叹气冒汗"
      ]
    }
  },
  eventsRefreshSec: { balance: 1800, whisper: 300 },
  animationWeights: { idle: 10, turn: 5, move: 5 }
};

/**
 * 将 DSH 插件内部发出的 /dsh-pet-7340/ 请求重定向为 zmod-local:// 协议资源。
 */
export function remapDshResourceUrl(url, pluginId = 'dsh-compat', dshDir = 'dsh-plugins') {
  if (typeof url !== 'string') return url;
  if (!url.includes('dsh-pet-7340')) return url;

  // 1. 动画 webm: /thumb/<assetRoot>/<file>
  const mThumb = url.match(/\/dsh-pet-7340\/thumb\/[^/]+\/([^?#]+)/);
  if (mThumb) {
    return `zmod-local://plugins/${pluginId}/${dshDir}/dsh-pet/assets/webm/${mThumb[1]}`;
  }

  // 2. 图片: /pic/<file>
  const mPic = url.match(/\/dsh-pet-7340\/pic\/([^?#]+)/);
  if (mPic) {
    return `zmod-local://plugins/${pluginId}/${dshDir}/dsh-pet/assets/pic/${mPic[1]}`;
  }

  // 3. 字体: /font/<file>
  const mFont = url.match(/\/dsh-pet-7340\/font\/([^?#]+)/);
  if (mFont) {
    return `zmod-local://plugins/${pluginId}/${dshDir}/dsh-pet/assets/fonts/${mFont[1]}`;
  }

  return url;
}

// ---- DSH 插件市场注册表与远端拉取 --------------------------------------------

export const PRIMARY_MARKET_REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json';
export const FALLBACK_MARKET_REGISTRY_URL =
  'https://ghfast.top/https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/plugins.json';

export const FALLBACK_CATALOG = {
  name: 'awesome-dsh-plugin',
  updated: '2026-10-29',
  count: 6,
  categories: {
    ui: { en: 'UI Enhancements', zh: 'UI 增强' },
    pet: { en: 'Desktop Pets', zh: '桌面宠物' },
    tool: { en: 'Tools & Utilities', zh: '实用工具' },
    theme: { en: 'Themes', zh: '界面主题' }
  },
  plugins: [
    {
      name: 'dsh-pet',
      npm: 'dsh-pet',
      description: 'Q版蓝发小女仆桌宠，支持多动作物理碰撞与对话交互',
      category: ['pet', 'ui'],
      author: 'DSH Team',
      version: '0.3.8',
      license: 'MIT'
    },
    {
      name: 'dshmarket',
      npm: 'dshmarket',
      description: 'DSH 可视化插件市场：逛一逛，点一下，装好。',
      category: ['tool', 'ui'],
      author: 'DSH Community',
      version: '1.73.3',
      license: 'MIT'
    },
    {
      name: 'dsh-whale-widget',
      npm: 'dsh-whale-widget',
      description: '大肥鱼余额小挂件，实时展示用量与状态',
      category: ['ui'],
      author: 'DSH Team',
      version: '0.2.1',
      license: 'MIT'
    },
    {
      name: 'dsh-mcp-connector',
      npm: 'dsh-mcp-connector',
      description: 'DSH 模型上下文协议（MCP）本地服务桥接器',
      category: ['tool'],
      author: 'DSH Community',
      version: '1.2.0',
      license: 'MIT'
    },
    {
      name: 'dsh-theme-chalk',
      npm: 'dsh-theme-chalk',
      description: '经典粉笔黑板暗色高对比度主题',
      category: ['theme'],
      author: 'DSH Community',
      version: '1.0.4',
      license: 'MIT'
    },
    {
      name: 'dsh-quick-notes',
      npm: 'dsh-quick-notes',
      description: '会话侧边便签本，随时记录关键代码与备忘',
      category: ['tool'],
      author: 'DSH Community',
      version: '0.5.2',
      license: 'MIT'
    }
  ]
};

/**
 * 带停滞看门狗的正文 JSON 读取。
 *
 * 响应头到达不代表正文会来：国内经代理拉 10MB 大文件的典型病态是"头秒到、
 * 正文停滞"，裸 res.json() 会永久挂起（市场转圈不止的根因）。对标 dshmarket
 * 官方 body-progress.js：逐块读流，每块重置停滞计时（默认 15s 无进展即放弃），
 * 另设总时长封顶（默认 90s，约 7x 慢速实测），超时经由 controller.abort()
 * 让 read() 以异常收场 → 进入下一源/降级。无流式 body 的环境（单测 mock）
 * 退回普通 json()。
 */
async function readBodyJsonWithStallGuard(res, controller, { stallMs = 15000, totalMs = 90000 } = {}) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') return res.json();
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let idleTimer = null;
  let totalTimer = null;
  const kill = () => {
    try { controller?.abort(); } catch {}
    try { reader.cancel(); } catch {}
  };
  try {
    if (totalMs > 0) totalTimer = setTimeout(kill, totalMs);
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (stallMs > 0) idleTimer = setTimeout(kill, stallMs);
    };
    resetIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      resetIdle();
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    return JSON.parse(new TextDecoder().decode(buf));
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
  }
}

/**
 * 远端拉取/刷新 dshmarket 插件注册表（带 memory cache、etag、lastModified 与 10 分钟 TTL）。
 */
export async function fetchMarketRegistry({
  force = false,
  fetchImpl = globalThis.fetch,
  cacheState = null,
  timeoutMs = 8000,
  stallMs = 15000,
  bodyTotalMs = 90000,
  urls = [PRIMARY_MARKET_REGISTRY_URL, FALLBACK_MARKET_REGISTRY_URL]
} = {}) {
  const now = Date.now();
  const cache = cacheState || { memoryCache: null, etag: null, lastModified: null, fetchTime: 0 };
  const CACHE_TTL = 10 * 60 * 1000; // 10 分钟缓存

  if (!force && cache.memoryCache && now - cache.fetchTime < CACHE_TTL) {
    return {
      registry: cache.memoryCache,
      hostVersion: '1.0.0',
      fromCache: true,
      fallback: cache.isFallback === true
    };
  }

  const headers = {};
  if (cache.etag) headers['If-None-Match'] = cache.etag;
  if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;

  for (const url of urls) {
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timer = null;
      if (controller && timeoutMs > 0) {
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      try {
        const res = await fetchImpl(url, {
          headers,
          signal: controller?.signal
        });
        if (timer) clearTimeout(timer);

        if (res.status === 304 && cache.memoryCache) {
          cache.fetchTime = now;
          return {
            registry: cache.memoryCache,
            hostVersion: '1.0.0',
            fromCache: true,
            notModified: true,
            fallback: cache.isFallback === true
          };
        }

        if (res.ok) {
          const data = await readBodyJsonWithStallGuard(res, controller, {
            stallMs,
            totalMs: bodyTotalMs
          });
          if (data && typeof data === 'object' && Array.isArray(data.plugins)) {
            cache.memoryCache = data;
            cache.isFallback = false;
            const h = res.headers;
            cache.etag = (typeof h?.get === 'function' ? h.get('etag') : h?.etag) || null;
            cache.lastModified =
              (typeof h?.get === 'function' ? h.get('last-modified') : h?.['last-modified']) || null;
            cache.fetchTime = now;
            return { registry: data, hostVersion: '1.0.0', updated: true, fallback: false };
          }
        }
      } catch (err) {
        if (timer) clearTimeout(timer);
      }
    } catch {}
  }

  // 远端全失败：复用旧缓存
  if (cache.memoryCache) {
    return {
      registry: cache.memoryCache,
      hostVersion: '1.0.0',
      fromCache: true,
      degraded: true,
      fallback: cache.isFallback === true
    };
  }

  // 首次离线兜底
  cache.memoryCache = FALLBACK_CATALOG;
  cache.isFallback = true;
  cache.fetchTime = now;
  return { registry: FALLBACK_CATALOG, hostVersion: '1.0.0', fallback: true };
}

// ---- 桌宠状态机长轮询管理 ----------------------------------------------------

/**
 * 构造桌宠状态机管理对象（处理 /dsh-pet-7340/state 的 long polling 挂起与变更通知）。
 */
export function createPetStateManager(initialCounter = 1) {
  let counter = initialCounter;
  const waiters = new Set();

  function notifyChange() {
    counter++;
    for (const w of waiters) {
      try { w(); } catch {}
    }
    waiters.clear();
  }

  async function handleStateRequest(url, init = {}) {
    let reqSince = null;
    let timeoutMs = 15000;

    try {
      const u = new URL(url, 'http://127.0.0.1');
      const s = u.searchParams.get('since');
      if (s !== null) {
        const n = Number(s);
        if (Number.isFinite(n)) reqSince = n;
      }
      const t = u.searchParams.get('timeout') || u.searchParams.get('timeoutMs');
      if (t !== null) {
        const parsedT = Number(t);
        if (Number.isFinite(parsedT)) {
          timeoutMs = Math.max(1000, Math.min(30000, parsedT));
        }
      }
    } catch {}

    // 客户端传入 since 且当前 counter 尚未递增：挂起等待，绝不能 0ms 同步返回旧 counter
    if (reqSince !== null && reqSince >= counter) {
      await new Promise((resolve) => {
        let timer = null;
        const wake = () => {
          if (timer) clearTimeout(timer);
          waiters.delete(wake);
          if (init?.signal) init.signal.removeEventListener?.('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          waiters.delete(wake);
          if (init?.signal) init.signal.removeEventListener?.('abort', onAbort);
          resolve();
        };

        if (init?.signal?.aborted) {
          resolve();
          return;
        }

        if (init?.signal) {
          init.signal.addEventListener?.('abort', onAbort, { once: true });
        }

        timer = setTimeout(wake, timeoutMs);
        waiters.add(wake);
      });
    }

    return {
      counter,
      sections: {},
      pets: {}
    };
  }

  function destroy() {
    for (const w of waiters) {
      try { w(); } catch {}
    }
    waiters.clear();
  }

  return {
    getCounter: () => counter,
    notifyChange,
    handleStateRequest,
    destroy
  };
}


