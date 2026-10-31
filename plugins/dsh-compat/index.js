import { definePlugin } from '@zmod/sdk';
import {
  filterLoadablePackages,
  buildRequireTable,
  createDshContext,
  createLayoutService,
  createLocaleService,
  createThemeService,
  sortSlots,
  parsePackageSpec,
  resolvePackageMeta,
  DEFAULT_REGISTRIES,
  remapDshResourceUrl,
  DEFAULT_PET_CONFIG,
  createPetStateManager,
  fetchMarketRegistry,
  FALLBACK_CATALOG
} from './lib.js';

/**
 * dsh-compat — DSH（DeepSeek Harness）插件兼容层。
 *
 * 让 ZMod 装载可兼容的 DSH 客户端插件（npm 包的浏览器半侧）：
 * 1. 支持直接输入 DSH 插件名（如 dsh-pet、dsh-whale-widget）或 .tgz 链接一键在线安装；
 * 2. 提供 window.__ModuleLoader__ 垫片收集 load({id, factory}) 调用；
 * 3. 用 vendor React 18 UMD + 手写 jsx 垫片充当平台种子模块（react / react-dom /
 *    react-dom/client / react/jsx-runtime）；
 * 4. 用 Cordis 风格 ctx（effect/provide/服务同名属性注入）驱动 factory 返回的
 *    { name, inject, apply } 三件套，并把 'shell.overlay' 槽位渲染成页面覆盖层。
 *
 * 能力边界（见设置说明）：纯客户端视觉类插件完整可用；依赖 DSH 宿主半侧
 * （Cordis 主进程、webserver HTTP 接口、桌面窗口 helper）的插件降级运行——
 * 界面在但数据不可用。'settings.section' 槽位在 ZMod 无对应渲染面，跳过。
 */

const PLUGIN_ID = 'dsh-compat';
const DSH_DIR = 'dsh-plugins';
const LOADER_MARK = '__zmod_dsh_compat__';
const PORTAL_ID = 'zmod-mount-portal';

const SAMPLE_PLUGINS = [
  { name: 'dsh-pet', label: 'dsh-pet (桌宠大肥鱼)' },
  { name: 'dsh-whale-widget', label: 'dsh-whale-widget (余额小鲸鱼)' }
];

const SKIP_REASON_LABEL = {
  'no-package-json': 'package.json 不可读',
  'no-client-entry': '纯宿主半侧包：无 client 入口'
};

const STATUS_LABEL = {
  loaded: '已装载',
  disabled: '已停用',
  error: '失败',
  skipped: '跳过',
  'host-only': '跳过'
};

// start() 填充；actions / renderSettings 读取。插件禁用后置 null。
let runtime = null;

export default definePlugin({
  id: 'dsh-compat',
  name: 'DSH 插件兼容层',
  version: '0.2.1',
  description:
    '装载可兼容的 DSH（DeepSeek Harness）客户端插件：支持输入插件名或链接直接从 npm 下载安装；提供 ModuleLoader 垫片 + react 种子模块 + Cordis 风格 ctx 模拟；纯客户端视觉类插件完整可用，依赖宿主服务的插件降级运行',
  author: 'ZMod Team',

  settings: {
    enabled: {
      type: 'switch',
      title: '启用 DSH 兼容层',
      description: '关闭后卸载全部 DSH 插件；重新开启后点"重新扫描并装载"生效',
      default: true
    },
    packageList: {
      type: 'text',
      title: '手动指定包名 (逗号分隔)',
      description: '老基座无自动扫描 RPC 时，可填入 dsh-plugins/ 下的包名手动加载（如 dsh-pet）',
      default: ''
    },
    info: {
      type: 'group',
      title: 'DSH 插件目录：<数据目录>/plugins/dsh-compat/dsh-plugins/'
    }
  },

  actions: {
    rescan: {
      title: '重新扫描并装载 DSH 插件',
      description: '卸载当前已装载的 DSH 插件，重跑发现与装载流程',
      run: async () => {
        if (!runtime) return { ok: false, message: 'dsh-compat 尚未启动（先启用插件）' };
        try {
          runtime.unloadAll();
          await runtime.runAll();
          const n = runtime.loadedCount();
          return { ok: true, message: `扫描完成：装载 ${n} 个 DSH 插件` };
        } catch (err) {
          console.error('[dsh-compat] 重新扫描失败:', err);
          return { ok: false, message: `重新扫描失败：${err?.message || err}` };
        }
      }
    }
  },

  /**
   * 自定义设置区（DSH「插件」页 1:1 伪装壳）：
   * 顶部分段「已安装 | 插件市场」——已安装 = 分组列表（内置插件配置 / 社区插件 / 实验性插件），
   * 插件市场 = 内嵌挂载 dshmarket 注册的真实 settings.section 元素。
   * 容器上定义 --dsw-alias-* 令牌，使 dshmarket 的打包 CSS 原生取色。
   */
  renderSettings(container, helpers) {
    container.className = '';
    container.style.cssText = [
      '--dsw-alias-bg-base:#0f0f10',
      '--dsw-alias-bg-layer-1:#141416',
      '--dsw-alias-bg-layer-2:#1a1a1c',
      '--dsw-alias-bg-overlay:#202023',
      '--dsw-alias-label-primary:#ececec',
      '--dsw-alias-label-secondary:#9b9b9f',
      '--dsw-alias-label-tertiary:#6d6d72',
      '--dsw-alias-brand-primary:#4f6ef7'
    ].join(';');
    container.style.fontFamily = '"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
    container.style.fontSize = '14px';
    container.style.color = 'var(--dsw-alias-label-primary)';
    container.style.lineHeight = '1.5';

    const toast = (msg, type) => {
      try { (helpers.toast || ((m) => runtime?.ui?.showToast(m)))(msg, type); } catch {}
    };

    // ---- 样式注入（幂等） ----
    const STYLE_ID = 'dshp-page-style';
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = `
#dshp-page{--bd:rgba(255,255,255,.07);--bd2:rgba(255,255,255,.13)}
#dshp-page *{box-sizing:border-box;margin:0;padding:0}
#dsh-zcode-restyle button,#dshp-page button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}
#dshp-page input,#dshp-page select{font:inherit}
#dshp-page .pg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
#dshp-page .pg-title{font-size:26px;font-weight:700}
#dshp-page .pg-sub{display:flex;align-items:center;gap:7px;margin-top:4px;font-size:13px;color:var(--dsw-alias-label-secondary)}
#dshp-page .pg-actions{display:flex;align-items:center;gap:10px;min-height:40px}
#dshp-page .iconbtn{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
#dshp-page .iconbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
#dshp-page .addbtn-wrap{position:relative}
#dshp-page .addbtn{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 8px 0 14px;border-radius:10px;background:#e9ebee;color:#141416;font-size:14px;font-weight:600}
#dshp-page .addbtn:hover{background:#f5f6f8}
#dshp-page .addsep{width:1px;height:18px;background:rgba(0,0,0,.18);margin:0 2px}
#dshp-page .addmenu{position:absolute;right:0;top:42px;z-index:40;width:230px;padding:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--bd2);border-radius:11px;box-shadow:0 14px 36px rgba(0,0,0,.55);display:none}
#dshp-page .addmenu.is-open{display:block}
#dshp-page .addmenu .arow{display:flex;align-items:center;gap:9px;width:100%;padding:9px 10px;border-radius:8px;font-size:13px;color:var(--dsw-alias-label-primary);text-align:left}
#dshp-page .addmenu .arow:hover{background:rgba(255,255,255,.07)}
#dshp-page .seg{display:inline-flex;margin-top:20px;background:var(--dsw-alias-bg-layer-2);border-radius:11px;padding:3px}
#dshp-page .seg button{height:34px;padding:0 22px;border-radius:8px;font-size:14px;color:var(--dsw-alias-label-secondary);border:1px solid transparent}
#dshp-page .seg button:hover{color:var(--dsw-alias-label-primary)}
#dshp-page .seg button.is-active{background:var(--dsw-alias-bg-overlay);border-color:rgba(255,255,255,.2);color:var(--dsw-alias-label-primary);font-weight:600}
#dshp-page .grphead{margin:26px 0 12px;display:flex;align-items:center;justify-content:space-between;font-size:15px;font-weight:700}
#dshp-page .grphead .quiet{font-weight:400;font-size:13px;color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;gap:4px}
#dshp-page .grphead .quiet:hover{color:var(--dsw-alias-label-primary)}
#dshp-page .confrow{display:flex;align-items:center;gap:14px;padding:13px 4px;border-bottom:1px solid var(--bd)}
#dshp-page .confrow:last-child{border-bottom:none}
#dshp-page .confrow .tile{width:46px;height:46px;border-radius:13px;flex:none;display:flex;align-items:center;justify-content:center;font-size:21px}
#dshp-page .confrow .cname{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
#dshp-page .confrow .cdesc{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin-top:1px}
#dshp-page .confrow .chev{margin-left:auto;color:var(--dsw-alias-label-tertiary);transition:transform .15s}
#dshp-page .confrow[data-open="true"] .chev{transform:rotate(90deg)}
#dshp-page .confbody{display:none;padding:4px 4px 14px 64px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
#dshp-page .confbody.is-open{display:block}
#dshp-page .etag{height:20px;padding:0 8px;border-radius:6px;background:rgba(79,110,247,.16);color:#8fa2ff;font-size:11px;display:inline-flex;align-items:center;font-weight:400}
#dshp-page .iact{height:26px;padding:0 11px;border-radius:7px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--bd);font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap}
#dshp-page .iact:hover{background:#26262a}
#dshp-page .iact.is-quiet{color:var(--dsw-alias-label-secondary)}
#dshp-page .iact.is-danger:hover{border-color:rgba(239,107,94,.5);color:var(--red,#ef6b5e)}
#dshp-page .iswitch{position:relative;width:36px;height:20px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--bd2);flex:none;transition:background .15s}
#dshp-page .iswitch::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s}
#dshp-page .iswitch.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
#dshp-page .iswitch.is-on::after{transform:translateX(16px);background:#fff}
#dshp-page .hostline{margin-top:18px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
#dshp-page .installrow{display:flex;gap:10px;margin-top:12px}
#dshp-page .installrow input{flex:1;height:32px;padding:0 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--bd);color:var(--dsw-alias-label-primary);font-size:12px;outline:none;min-width:0}
#dshp-page .installrow input:focus{border-color:var(--dsw-alias-brand-primary)}
#dshp-page .installrow input::placeholder{color:var(--dsw-alias-label-tertiary)}
#dshp-page .installrow select{height:32px;padding:0 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--bd);color:var(--dsw-alias-label-primary);font-size:12px;outline:none}
#dshp-page .primary{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;border-radius:9px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:12px;font-weight:500;white-space:nowrap}
#dshp-page .primary:hover{filter:brightness(1.1)}
#dshp-page .primary:disabled{opacity:.5;cursor:default}
#dshp-page .mkthost{margin-top:12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
#dshp-page .mktmount{margin-top:6px}
`;
      document.head.appendChild(st);
    }

    container.innerHTML = '';
    const page = document.createElement('div');
    page.id = 'dshp-page';
    container.appendChild(page);

    // ---- 顶栏：标题 + 右上动作区（随分段联动） ----
    const head = document.createElement('div');
    head.className = 'pg-head';
    const titleBlock = document.createElement('div');
    // 版本戳直接上屏：用户不开 DevTools 就能确认渲染层跑的是哪个 build
    titleBlock.innerHTML =
      '<div class="pg-title">插件</div>' +
      '<div class="pg-sub">安装、启用和配置 DSH 插件 · 兼容层 v0.2.1 (build 20261031)</div>';
    head.appendChild(titleBlock);
    const actions = document.createElement('div');
    actions.className = 'pg-actions';
    const actInstalled = document.createElement('div');
    actInstalled.style.cssText = 'display:none;align-items:center;gap:10px';

    const rescanBtn = document.createElement('button');
    rescanBtn.type = 'button';
    rescanBtn.className = 'iconbtn';
    rescanBtn.title = '重新扫描并装载';
    rescanBtn.textContent = '↻';
    rescanBtn.addEventListener('click', async () => {
      rescanBtn.disabled = true;
      try { await helpers.onAction('rescan'); } finally { rescanBtn.disabled = false; }
    });
    actInstalled.appendChild(rescanBtn);

    const addWrap = document.createElement('div');
    addWrap.style.position = 'relative';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'addbtn';
    addBtn.innerHTML = '+ 添加插件 <span class="addsep"></span> ▾';
    const addMenu = document.createElement('div');
    addMenu.className = 'addmenu';
    const mkAddRow = (icon, label) => {
      const r = document.createElement('button');
      r.type = 'button';
      r.className = 'arow';
      r.innerHTML = `${icon} ${label}`;
      addMenu.appendChild(r);
      return r;
    };
    const rowNpm = mkAddRow('📦', '从 npm 安装（输入包名）');
    const rowTgz = mkAddRow('🔗', '从 .tgz 链接安装');
    const rowMkt = mkAddRow('🛒', '从市场安装（切到插件市场）');
    addWrap.appendChild(addBtn);
    addWrap.appendChild(addMenu);
    actInstalled.appendChild(addWrap);
    actions.appendChild(actInstalled);
    head.appendChild(actions);
    page.appendChild(head);

    // ---- 分段控件 ----
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'tablist');
    const segInstalled = document.createElement('button');
    segInstalled.type = 'button';
    segInstalled.textContent = '已安装';
    const segMarket = document.createElement('button');
    segMarket.type = 'button';
    segMarket.textContent = '插件市场';
    seg.appendChild(segInstalled);
    seg.appendChild(segMarket);
    page.appendChild(seg);

    const pageInstalled = document.createElement('div');
    const pageMarket = document.createElement('div');
    page.appendChild(pageInstalled);
    page.appendChild(pageMarket);

    let installRowEl = null;
    const showInstallRow = (focus) => {
      if (!installRowEl) {
        installRowEl = document.createElement('div');
        installRowEl.className = 'installrow';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = '输入插件包名 (如 dsh-pet) 或 .tgz 链接';
        const sel = document.createElement('select');
        for (const [, reg] of Object.entries(DEFAULT_REGISTRIES)) {
          const opt = document.createElement('option');
          opt.value = reg.url;
          opt.textContent = reg.name;
          sel.appendChild(opt);
        }
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'primary';
        go.textContent = '下载并安装';
        go.addEventListener('click', async () => {
          const raw = inp.value.trim();
          if (!raw) { toast('请输入 DSH 插件名或安装链接', 'warn'); return; }
          const spec = parsePackageSpec(raw);
          if (!spec) { toast('无法解析的包名或链接格式', 'error'); return; }
          go.disabled = true;
          try {
            const meta = await resolvePackageMeta(spec, sel.value || DEFAULT_REGISTRIES.npmmirror.url);
            const res = await runtime?.invoke?.('plugin.installArchive', {
              pluginId: PLUGIN_ID,
              relPath: `${DSH_DIR}/${meta.name}`,
              url: meta.tarballUrl
            });
            if (!res || !res.ok) throw new Error(res?.error || '基座未提供解压端口');
            toast(`DSH 插件 ${meta.name} 安装成功`, 'success');
            inp.value = '';
            await helpers.onAction('rescan');
          } catch (err) {
            console.error('[dsh-compat] 安装失败:', err);
            toast(`安装失败: ${err?.message || err}`, 'error');
          } finally {
            go.disabled = false;
          }
        });
        installRowEl.appendChild(inp);
        installRowEl.appendChild(sel);
        installRowEl.appendChild(go);
        pageInstalled.appendChild(installRowEl);
      }
      installRowEl.style.display = '';
      if (focus) installRowEl.querySelector('input')?.focus();
    };

    rowNpm.addEventListener('click', () => { switchSeg('installed'); showInstallRow(true); });
    rowTgz.addEventListener('click', () => { switchSeg('installed'); showInstallRow(true); });
    rowMkt.addEventListener('click', () => { switchSeg('market'); });
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); addMenu.classList.toggle('is-open'); });
    page.addEventListener('click', () => addMenu.classList.remove('is-open'));

    // ---- 分段切换 ----
    let marketMounted = false;
    function switchSeg(name) {
      const isMarket = name === 'market';
      segInstalled.classList.toggle('is-active', !isMarket);
      segMarket.classList.toggle('is-active', isMarket);
      pageInstalled.style.display = isMarket ? 'none' : '';
      pageMarket.style.display = isMarket ? '' : 'none';
      actInstalled.style.display = isMarket ? 'none' : 'flex';
      if (isMarket && !marketMounted) mountMarket();
    }

    // ---- 已安装页：分组列表 ----
    const groupInstalled = () => {
      pageInstalled.innerHTML = '';

      // 内置插件配置：真实 settings.section 挂载（dsh-pet 桌宠配置）
      const gh1 = document.createElement('div');
      gh1.className = 'grphead';
      gh1.innerHTML = '<span>内置插件配置</span>';
      pageInstalled.appendChild(gh1);
      const cfgPkgs = [...(runtime?.settingsSections?.keys?.() || [])].filter((n) => n !== 'dshmarket');
      if (!cfgPkgs.length) {
        const empty = document.createElement('div');
        empty.className = 'hostline';
        empty.style.marginTop = '0';
        empty.textContent = '暂无已装载 DSH 插件提供配置分区。';
        pageInstalled.appendChild(empty);
      }
      for (const pkgName of cfgPkgs) {
        const displayName = pkgName === 'dsh-pet' ? '桌宠配置' : pkgName;
        const row = document.createElement('div');
        row.className = 'confrow';
        row.setAttribute('data-cfg', 'true');
        row.innerHTML =
          `<span class="tile" style="background:linear-gradient(140deg,#2f9e8f,#1f6e63)">${pkgName === 'dsh-pet' ? '🐾' : '🧩'}</span>` +
          `<div style="flex:1;min-width:0"><div class="cname">${displayName}</div>` +
          `<div class="cdesc">由 ${pkgName} 的 settings.section 提供</div></div>` +
          '<i class="chev">›</i>';
        const body = document.createElement('div');
        body.className = 'confbody';
        pageInstalled.appendChild(row);
        pageInstalled.appendChild(body);
        row.addEventListener('click', () => {
          const open = row.getAttribute('data-open') === 'true';
          row.setAttribute('data-open', open ? 'false' : 'true');
          body.classList.toggle('is-open', !open);
          if (!open && !body.dataset.mounted) {
            mountPkgSection(pkgName, body);
            body.dataset.mounted = '1';
          }
        });
      }

      // 社区插件：真实已发现包列表
      const gh2 = document.createElement('div');
      gh2.className = 'grphead';
      const pkgs = (runtime?.discovered || []).filter((p) => p.loadable !== false);
      gh2.innerHTML = `<span>社区插件 (${pkgs.length})</span><span class="quiet">来自 dsh-plugins/ 目录</span>`;
      pageInstalled.appendChild(gh2);
      if (!pkgs.length) {
        const empty = document.createElement('div');
        empty.className = 'hostline';
        empty.style.marginTop = '0';
        empty.textContent = '未发现 DSH 插件包 — 右上「添加插件」或切到插件市场安装。';
        pageInstalled.appendChild(empty);
      }
      for (const pkg of pkgs) {
        const status = runtime?.statuses?.get(pkg.name);
        const row = document.createElement('div');
        row.className = 'confrow';
        row.innerHTML =
          `<span class="tile" style="background:linear-gradient(140deg,#3b62a8,#27406e)">${pkg.name === 'dsh-pet' ? '🐟' : '🧩'}</span>` +
          `<div style="flex:1;min-width:0"><div class="cname">${pkg.displayName || pkg.name} <span class="etag">v${pkg.version || '0'}</span></div>` +
          `<div class="cdesc">${pkg.clientPath || ''}</div></div>`;
        if (status === 'loaded') {
          const dot = document.createElement('span');
          dot.style.cssText = 'font-size:11px;color:var(--green,#3fbf6f);white-space:nowrap';
          dot.textContent = '已装载';
          row.appendChild(dot);
        }
        if (pkg.clientPath) {
          const sw = document.createElement('button');
          sw.type = 'button';
          sw.className = 'iswitch' + (runtime?.isPkgEnabled?.(pkg.name) === false ? '' : ' is-on');
          sw.title = '启停该插件';
          sw.addEventListener('click', async () => {
            const next = !sw.classList.contains('is-on');
            sw.classList.toggle('is-on', next);
            try { await runtime?.setPkgEnabled?.(pkg.name, next); } catch {}
            toast(next ? `${pkg.name} 已启用，重扫后生效` : `${pkg.name} 已停用，重扫后生效`, 'info');
          });
          row.appendChild(sw);
        }
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'iact is-quiet is-danger';
        rm.textContent = '移除';
        rm.addEventListener('click', async () => {
          if (!confirm(`确定要移除 DSH 插件 ${pkg.displayName || pkg.name} 吗？`)) return;
          try {
            const r = await runtime?.invoke?.('plugin.removeDir', {
              pluginId: PLUGIN_ID,
              relPath: `${DSH_DIR}/${pkg.dirName || pkg.name}`
            });
            if (!r || !r.ok) throw new Error(r?.error || '移除失败');
            toast(`已移除 ${pkg.name}`, 'info');
            await helpers.onAction('rescan');
          } catch (err) {
            toast(`移除失败: ${err?.message || err}`, 'error');
          }
        });
        row.appendChild(rm);
        pageInstalled.appendChild(row);
      }

      // 实验性插件：桌面独立小窗（真实联动 dsh.syncHelper）
      const gh3 = document.createElement('div');
      gh3.className = 'grphead';
      gh3.innerHTML = '<span>实验性插件</span>';
      pageInstalled.appendChild(gh3);
      const expRows = [
        {
          icon: '🪟', grad: 'linear-gradient(140deg,#3450c9,#232f6e)', name: '桌面独立小窗',
          desc: '在 Windows 桌面创建透明置顶小窗承载桌宠（electron-helper）。',
          key: 'desktopHelperEnabled', def: true,
          onChange: async (on) => {
            try {
              if (on) {
                const userCfg = runtime?.settings?.get('petUserConfig', null);
                const cfg = userCfg ? { ...DEFAULT_PET_CONFIG, ...userCfg } : DEFAULT_PET_CONFIG;
                await runtime?.invoke?.('dsh.syncHelper', { activeConfig: cfg, enabled: true });
              } else {
                await runtime?.invoke?.('dsh.stopHelper', {});
              }
            } catch {}
          }
        },
        {
          icon: '📦', grad: 'linear-gradient(140deg,#2f9e8f,#1f6e63)', name: 'npm 直装内核',
          desc: '不经市场直接按包名或 .tgz 链接安装 DSH 插件。',
          key: 'npmInstallEnabled', def: true, onChange: null
        }
      ];
      for (const item of expRows) {
        const row = document.createElement('div');
        row.className = 'confrow';
        row.innerHTML =
          `<span class="tile" style="background:${item.grad}">${item.icon}</span>` +
          `<div style="flex:1;min-width:0"><div class="cname">${item.name} <span class="etag">实验性</span></div>` +
          `<div class="cdesc">${item.desc}</div></div>`;
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'iswitch' + (runtime?.settings?.get(item.key, item.def) ? ' is-on' : '');
        sw.addEventListener('click', async () => {
          const on = !sw.classList.contains('is-on');
          sw.classList.toggle('is-on', on);
          try { await runtime?.settings?.set(item.key, on); } catch {}
          if (item.onChange) await item.onChange(on);
        });
        row.appendChild(sw);
        pageInstalled.appendChild(row);
      }

      const hl = document.createElement('div');
      hl.className = 'hostline';
      hl.textContent = '落包目录：dsh-compat/dsh-plugins/<包名>/ · 兼容层 v0.2.1';
      pageInstalled.appendChild(hl);
    };

    // 挂载某个 DSH 插件的 settings.section（React 元素）
    function mountPkgSection(pkgName, bodyEl) {
      const sections = runtime?.settingsSections?.get?.(pkgName) || [];
      if (!sections.length || !runtime?.React || !runtime?.ReactDOM) {
        bodyEl.textContent = '该插件的配置分区尚未注册。';
        return;
      }
      for (const sec of sections) {
        const host = document.createElement('div');
        bodyEl.appendChild(host);
        try {
          const root = runtime.ReactDOM.createRoot(host);
          const comp =
            typeof sec.render === 'function'
              ? runtime.React.createElement(sec.render, { t: (k) => k, view: 'page' })
              : sec.render;
          if (comp) {
            root.render(comp);
            runtime.sectionRoots.push(root);
          }
        } catch (e) {
          console.error(`[dsh-compat] ${pkgName} 配置分区挂载失败:`, e);
          host.textContent = `配置加载失败: ${e?.message || e}`;
        }
      }
    }

    // ---- 插件市场页：内嵌挂载 dshmarket 真实元素 ----
    let marketRoot = null;
    function mountMarket() {
      marketMounted = true;
      pageMarket.className = 'mktmount';
      const sections = runtime?.settingsSections?.get?.('dshmarket') || [];
      if (!sections.length || !runtime?.React || !runtime?.ReactDOM) {
        const empty = document.createElement('div');
        empty.className = 'mkthost';
        empty.textContent = 'dshmarket 未装载，无法展示市场 — 右上「添加插件」可直接安装。';
        pageMarket.appendChild(empty);
        return;
      }
      const host = document.createElement('div');
      pageMarket.appendChild(host);
      const sec = sections[0];
      try {
        marketRoot = runtime.ReactDOM.createRoot(host);
        const comp =
          typeof sec.render === 'function'
            ? runtime.React.createElement(sec.render, { view: 'page' })
            : sec.render;
        if (comp) marketRoot.render(comp);
      } catch (err) {
        console.error('[dsh-compat] 市场挂载失败:', err);
        host.textContent = `市场加载失败: ${err?.message || err}`;
      }
    }

    segInstalled.addEventListener('click', () => switchSeg('installed'));
    segMarket.addEventListener('click', () => switchSeg('market'));

    // 初始：market 段记忆（重绘保持）
    const lastSeg = runtime?.settings?.get('pageSegment', 'installed');
    groupInstalled();
    switchSeg(lastSeg === 'market' ? 'market' : 'installed');

    // 重绘钩子：槽位/状态变化时仅刷新已装列表
    const oldRepaint = runtime?.repaintSettings;
    runtime.repaintSettings = () => {
      try { groupInstalled(); } catch {}
      try { oldRepaint?.(); } catch {}
    };
  },

  async start(ctx) {
    const { settings: s, cleanup, invoke, ui } = ctx;
    console.log('[dsh-compat] 兼容层 v0.2.1 启动（build 20261031）');

    const state = {
      invoke,
      ui,
      React: null,
      ReactDOM: null,
      requireFor: null,
      loaderQueue: null,
      loaderOwned: false,
      servicesBag: {}, // 跨包共享的服务袋：provide 写入，后续包可经 get/注入读到
      cleanups: [], // 各 DSH 插件 effect 清理回调（整体 LIFO 执行）
      roots: [], // 已创建的 React root
      overlayEls: [], // shell.overlay 覆盖层容器
      scripts: [], // 注入的 <script> 元素（最终清理移除）
      discovered: [], // filterLoadablePackages 全量结果（含跳过项，供设置面展示）
      statuses: new Map(), // pkgName → loaded|disabled|error|host-only
      settingsSections: new Map(), // pkgName → [{ meta, render }]
      sidebarItems: new Map(), // pkgName → [{ meta, render }] (DSH 活动栏图标)
      mainPanels: new Map(), // pkgName → [{ meta, render }] (DSH 主工作区视窗)
      layoutService: createLayoutService(null),
      localeService: createLocaleService(
        String(typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh')
          .toLowerCase()
          .startsWith('zh')
          ? 'zh'
          : 'en'
      ),
      themeService: createThemeService('dark'),
      dockRoots: [], // DSH Dock 图标的 React roots
      dockEl: null, // DSH 浮动活动坞 DOM
      mainPanelEl: null, // DSH 主工作区全屏/抽屉视口 DOM
      mainPanelRoot: null, // DSH 主工作区 React root
      sectionRoots: [], // 设置面板 React roots
      unknownServices: new Set(), // 空对象降级的服务名（去重汇总一次）
      toastShown: new Set(),
      repaintSettings: null,
      unloadAll: null,
      runAll: null,
      loadedCount: () => [...state.statuses.values()].filter((v) => v === 'loaded').length,
      isPkgEnabled: (name) => s.get(`pkg:${name}`, true) !== false,
      setPkgEnabled: (name, bool) => s.set(`pkg:${name}`, bool),
      toast: (msg) => toastOnce(msg, 'info')
    };
    runtime = state;
    state.settings = s;

    const toastOnce = (msg, type) => {
      if (state.toastShown.has(msg)) return;
      state.toastShown.add(msg);
      try {
        ui.showToast(msg, type);
      } catch {}
    };

    const petStateManager = createPetStateManager(1);
    cleanup(() => {
      petStateManager.destroy();
    });

    const origFetch = window.fetch;
    const petFetchHandler = async (url, init) => {
      // 1. /dsh-pet-7340/config/meta
      if (url.includes('/dsh-pet-7340/config/meta')) {
        return new Response(
          JSON.stringify({
            default: 'plugins/dsh-compat/dsh-plugins/dsh-pet/assets/config.jsonc',
            user: 'plugins/dsh-compat/dsh-plugins/dsh-pet/assets/config.jsonc',
            animations: 'plugins/dsh-compat/dsh-plugins/dsh-pet/assets/webm/',
            memes: 'plugins/dsh-compat/dsh-plugins/dsh-pet/assets/pic/',
            storage: [],
            profile: 'zmod'
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      // 2. /dsh-pet-7340/config (GET / PUT / POST)
      if (url.includes('/dsh-pet-7340/config')) {
        const method = String(init?.method || 'GET').toUpperCase();
        if (method === 'PUT' || (method === 'POST' && init?.body)) {
          let updated = {};
          try {
            if (init.body) {
              const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
              const prev = s.get('petUserConfig', {}) || {};
              updated = { ...prev, ...body };
              await s.set('petUserConfig', updated);
            }
          } catch (e) {
            console.error('[dsh-compat] 保存桌宠配置失败:', e);
          }
          const fullMerged = {
            ...DEFAULT_PET_CONFIG,
            ...updated,
            animations: DEFAULT_PET_CONFIG.animations,
            animationWeights: DEFAULT_PET_CONFIG.animationWeights,
            eventsRefreshSec: DEFAULT_PET_CONFIG.eventsRefreshSec
          };
          invoke('dsh.syncHelper', { activeConfig: fullMerged, enabled: true }).catch(() => {});
          petStateManager.notifyChange();
          return new Response(JSON.stringify({ main: fullMerged }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (method === 'POST') {
          // doSync 同步/重置
          await s.set('petUserConfig', {});
          invoke('dsh.syncHelper', { activeConfig: DEFAULT_PET_CONFIG, enabled: true }).catch(() => {});
          petStateManager.notifyChange();
          return new Response(JSON.stringify({ main: DEFAULT_PET_CONFIG }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const userCfg = s.get('petUserConfig', null);
        const activeCfg = userCfg
          ? {
              ...DEFAULT_PET_CONFIG,
              ...userCfg,
              animations: DEFAULT_PET_CONFIG.animations,
              animationWeights: DEFAULT_PET_CONFIG.animationWeights,
              eventsRefreshSec: DEFAULT_PET_CONFIG.eventsRefreshSec
            }
          : DEFAULT_PET_CONFIG;
        return new Response(JSON.stringify({ main: activeCfg }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 3. /dsh-pet-7340/models
      if (url.includes('/dsh-pet-7340/models')) {
        return new Response(JSON.stringify({ providers: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 4. /dsh-pet-7340/state
      if (url.includes('/dsh-pet-7340/state')) {
        const statePayload = await petStateManager.handleStateRequest(url, init);
        return new Response(JSON.stringify(statePayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 5. 静态资源重映射（webm, pic, font）
      const remapped = remapDshResourceUrl(url, PLUGIN_ID, DSH_DIR);
      if (remapped !== url) {
        try {
          const res = await origFetch(remapped, init);
          if (res && res.ok) return res;
        } catch {}
        // Fallback: RPC readAsset
        const mRel = remapped.match(/zmod-local:\/\/plugins\/dsh-compat\/(.+)/);
        if (mRel) {
          try {
            const relPath = decodeURIComponent(mRel[1]);
            const r = await invoke('plugin.readAsset', { pluginId: PLUGIN_ID, relPath });
            if (r && r.ok) {
              const bin = atob(r.base64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
              const mime =
                ext === '.webm'
                  ? 'video/webm'
                  : ext === '.png'
                    ? 'image/png'
                    : ext === '.ttf'
                      ? 'font/ttf'
                      : 'application/octet-stream';
              return new Response(bytes, {
                status: 200,
                headers: { 'Content-Type': mime }
              });
            }
          } catch (e) {
            console.error('[dsh-compat] readAsset fallback error:', e);
          }
        }
      }

      // 6. 其他 /dsh-pet-7340 动作
      if (url.includes('dsh-pet-7340')) {
        return new Response(JSON.stringify({ ok: true, state: 'connected', balance: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return null;
    };

    // ---- 目录拉取通道：主进程系统代理会话优先 ----
    // 宿主把 defaultSession 钉死在直连（fallbackProxyMode:"direct"），国内直连目录源时好时坏；
    // net.fetchText 走独立 partition（system 代理），失败再退回渲染层 origFetch。
    const catalogFetchViaMain = async (url, opts = {}) => {
      const r = await invoke('net.fetchText', {
        url: String(url),
        headers: opts.headers || {},
        timeoutMs: 25000
      });
      if (!r || !r.ok) {
        const e = new Error(r?.error || `main-fetch HTTP ${r?.status ?? '?'}`);
        e.status = r?.status;
        throw e;
      }
      return {
        ok: r.ok === true,
        status: r.status,
        headers: { get: (k) => (r.headers && r.headers[String(k).toLowerCase()]) || null },
        json: async () => JSON.parse(r.text),
        text: async () => r.text
      };
    };
    const catalogFetch = async (url, opts = {}) => {
      try {
        return await catalogFetchViaMain(url, opts);
      } catch {
        return origFetch(url, opts);
      }
    };

    const marketRegistryCacheState = {
      memoryCache: null,
      etag: null,
      lastModified: null,
      fetchTime: 0
    };

    // ---- dshmarket 操作辅助：重扫装载 / POST body 解析 ----
    const rescanDsh = async () => {
      if (!runtime) return;
      try {
        runtime.unloadAll();
        await runtime.runAll();
      } catch (err) {
        console.error('[dsh-compat] rescan 失败:', err);
      }
    };
    const parsePostBody = (init) => {
      try {
        if (!init?.body) return {};
        return typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      } catch {
        return {};
      }
    };
    const jsonRes = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' }
      });

    const marketFetchHandler = async (url, init) => {
      const method = String(init?.method || 'GET').toUpperCase();

      // 1. /dsh-market/sidebar-entry (GET / POST) —— POST 需回 {ok:true, enabled} 契约
      if (url.includes('dsh-market/sidebar-entry')) {
        if (method === 'POST') {
          const body = parsePostBody(init);
          await s.set('marketSidebarEntry', body.enabled === true);
          return jsonRes({ ok: true, enabled: body.enabled === true, chosen: true });
        }
        const chosen = s.get('marketSidebarEntry', null);
        return jsonRes({ enabled: true, chosen: chosen === null ? false : chosen !== false });
      }

      // 2. /dsh-market/installed & /dsh-market/status
      if (url.includes('dsh-market/installed') || url.includes('dsh-market/status')) {
        const localInstalled = {};
        const disabled = [];
        for (const pkg of state.discovered || []) {
          localInstalled[pkg.name] = { version: pkg.version || '1.0.0' };
          if (state.isPkgEnabled && !state.isPkgEnabled(pkg.name)) disabled.push(pkg.name);
        }
        const favorites = s.get('marketFavorites', []);
        return jsonRes({
          active: false,
          idle: true,
          installed: localInstalled,
          repoIdentities: {},
          repoHints: {},
          present: Object.keys(localInstalled),
          live: [],
          disabled,
          notes: {},
          favorites: Array.isArray(favorites) ? favorites : [],
          blocked: [],
          updateExempt: [],
          bundles: [],
          unbundled: [],
          patchDisabled: [],
          configNamespaces: [],
          groups: {},
          groupOrder: [],
          activation: {},
          brokenPlugins: {},
          profile: 'zmod'
        });
      }

      // 3. /dsh-market/discovery-compatibility —— 契约：{plugins:{[name]:{status,basis,requirement,declarations}}, hostVersion}
      if (url.includes('dsh-market/discovery-compatibility')) {
        const body = parsePostBody(init);
        const names = [
          ...(Array.isArray(body.packages) ? body.packages : []),
          ...(Array.isArray(body.entries) ? body.entries : [])
        ];
        const plugins = {};
        for (const name of names) {
          if (typeof name !== 'string' || !name) continue;
          plugins[name] = {
            status: 'unknown',
            basis: 'unavailable',
            requirement: null,
            declarations: []
          };
        }
        return jsonRes({ plugins, hostVersion: null });
      }

      // 4. /dsh-market/check —— 契约：完整诊断报告（缺字段会让 check 页 TypeError）
      if (url.includes('dsh-market/check')) {
        return jsonRes({
          profile: 'zmod',
          scannedAt: Date.now(),
          bundles: [],
          rows: [],
          duplicates: [],
          duplicateNames: [],
          overrides: [],
          orphans: [],
          peerMismatches: [],
          multiVersion: [],
          orderConflicts: [],
          suggestedOrder: null,
          residuals: [],
          summary: { ok: true, errors: [], warnings: [] }
        });
      }

      // 5. /dsh-market/api/v1/capabilities
      if (url.includes('dsh-market/api/v1/capabilities')) {
        return jsonRes({
          schema: 'dsh-market/update-api/v1',
          version: '1.73.3',
          profile: 'zmod',
          runtime: 'desktop',
          restart: { supported: false }
        });
      }

      // 6. /dsh-market/api/v1/updates/summary
      if (url.includes('dsh-market/api/v1/updates/summary')) {
        return jsonRes({
          schema: 'dsh-market/update-api/v1',
          checked: 0,
          updatable: 0,
          packages: []
        });
      }

      // 7. /dsh-market/updates —— 契约：{updates:{[name]:info}}
      if (url.includes('dsh-market/updates')) {
        return jsonRes({ updates: {}, checkedAt: Date.now() });
      }

      // 8. /dsh-market/install —— 真实现：npm/tarball 解析 → installArchive → 热重扫
      if (url.includes('dsh-market/install')) {
        const body = parsePostBody(init);
        const raw = String(body.url || '').trim();
        if (!raw) return jsonRes({ ok: false, error: '缺少插件 url/name' }, 400);
        const spec = parsePackageSpec(raw);
        if (!spec) return jsonRes({ ok: false, error: `无法解析的插件地址: ${raw}` }, 400);
        // 仅接受 npm tarball 直链；GitHub 仓库页等交给明确报错（bsdtar 无法解 HTML）
        if (
          spec.isUrl &&
          !/^https?:\/\/.+\.(tgz|tar\.gz)(\?|$)/i.test(spec.url)
        ) {
          return jsonRes(
            { ok: false, error: '仅支持 npm 包名或 .tgz/.tar.gz 压缩包直链（暂不支持仓库页地址）' },
            400
          );
        }
        try {
          const meta = await resolvePackageMeta(spec, DEFAULT_REGISTRIES.npmmirror?.url);
          if (!runtime?.invoke) throw new Error('dsh-compat 尚未完成初始化');
          const res = await runtime.invoke('plugin.installArchive', {
            pluginId: PLUGIN_ID,
            relPath: `${DSH_DIR}/${meta.name}`,
            url: meta.tarballUrl
          });
          if (!res || !res.ok) {
            throw new Error(res?.error || '基座未提供解压或安装端口');
          }
          await rescanDsh();
          console.log(`[dsh-compat] dshmarket 安装成功: ${meta.name}@${meta.version || 'latest'}`);
          return jsonRes({ ok: true, hot: true, activation: {} });
        } catch (err) {
          console.error('[dsh-compat] dshmarket 安装失败:', err);
          return jsonRes({ ok: false, error: String(err?.message || err) }, 500);
        }
      }

      // 9. /dsh-market/uninstall —— 真实现：removeDir → 热重扫
      if (url.includes('dsh-market/uninstall')) {
        const body = parsePostBody(init);
        const name = String(body.name || '').trim();
        if (!name) return jsonRes({ ok: false, error: '缺少插件名' }, 400);
        try {
          if (!runtime?.invoke) throw new Error('dsh-compat 尚未完成初始化');
          const res = await runtime.invoke('plugin.removeDir', {
            pluginId: PLUGIN_ID,
            relPath: `${DSH_DIR}/${name}`
          });
          if (!res || !res.ok) throw new Error(res?.error || '移除失败');
          await rescanDsh();
          console.log(`[dsh-compat] dshmarket 卸载成功: ${name}`);
          return jsonRes({ ok: true, hot: true, refresh: false });
        } catch (err) {
          console.error('[dsh-compat] dshmarket 卸载失败:', err);
          return jsonRes({ ok: false, error: String(err?.message || err) }, 500);
        }
      }

      // 10. /dsh-market/toggle —— 真实现：pkg:<name> 设置开关 → 热重扫
      if (url.includes('dsh-market/toggle')) {
        const body = parsePostBody(init);
        const name = String(body.name || '').trim();
        const enabled = body.enabled === true;
        if (!name) return jsonRes({ ok: false, error: '缺少插件名' }, 400);
        try {
          await s.set(`pkg:${name}`, enabled);
          await rescanDsh();
          const disabled = (state.discovered || [])
            .filter((p) => state.isPkgEnabled && !state.isPkgEnabled(p.name))
            .map((p) => p.name);
          return jsonRes({ ok: true, hot: true, disabled, live: [] });
        } catch (err) {
          return jsonRes({ ok: false, error: String(err?.message || err) }, 500);
        }
      }

      // 11. /dsh-market/favorite —— 持久化收藏到插件设置
      if (url.includes('dsh-market/favorite')) {
        const body = parsePostBody(init);
        const urlKey = String(body.url || '');
        const favorited = body.favorited === true;
        const cur = s.get('marketFavorites', []);
        const list = Array.isArray(cur) ? cur.filter((x) => x !== urlKey) : [];
        if (favorited) list.push(urlKey);
        await s.set('marketFavorites', list);
        return jsonRes({ ok: true, favorites: list });
      }

      // 12. /dsh-market/registry
      if (url.includes('dsh-market/registry')) {
        const isForce = /[?&]force=1\b/.test(url) || init?.cache === 'no-store';
        // 外层总闸：即便正文看门狗失效也保证 45s 内必有应答，市场不会永久转圈
        const res = await Promise.race([
          fetchMarketRegistry({
            force: isForce,
            fetchImpl: catalogFetch,
            cacheState: marketRegistryCacheState
          }),
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  registry: marketRegistryCacheState.memoryCache || FALLBACK_CATALOG,
                  hostVersion: '1.0.0',
                  fromCache: true,
                  degraded: true
                }),
              45000
            )
          )
        ]);
        const catalogSize = Array.isArray(res.registry?.plugins) ? res.registry.plugins.length : 0;
        const isRealCatalog = !res.fallback && catalogSize > 0;
        if (isRealCatalog) {
          console.log(
            `[dsh-compat] 市场 catalog: ${catalogSize} 款插件` +
              `（${res.fromCache ? '缓存' : '远端'}, updated=${res.registry.updated}）`
          );
          if (res.degraded) {
            toastOnce(`官方源暂不可达，市场显示离线缓存（${catalogSize} 款）`, 'warn');
          } else {
            toastOnce(`插件市场已连接官方生态：${catalogSize} 款插件`, 'success');
          }
        } else {
          console.warn('[dsh-compat] 市场 catalog: 远端不可达，使用内置兜底（6 款）');
          toastOnce('插件市场暂未连上官方源，正在使用离线兜底列表', 'warn');
        }
        return new Response(
          JSON.stringify({
            registry: res.registry,
            hostVersion: res.hostVersion || '1.0.0'
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      // 13. 其他 /dsh-market/* 兜底（偏好类假成功：note / channel / backup 等后续真实现）
      if (url.includes('dsh-market')) {
        return jsonRes({ ok: true });
      }
      return null;
    };

    window.fetch = async function (input, init) {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input || '');
      if (url.includes('dsh-pet-7340')) {
        const handled = await petFetchHandler(url, init);
        if (handled) return handled;
      }
      if (url.includes('dsh-market')) {
        const handled = await marketFetchHandler(url, init);
        if (handled) return handled;
      }
      return origFetch.apply(this, arguments);
    };

    const loadScript = (src) =>
      new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = false;
        el.onload = () => resolve(el);
        el.onerror = () => {
          el.remove();
          reject(new Error(`脚本加载失败: ${src}`));
        };
        (document.head || document.documentElement || document).appendChild(el);
      });

    const unloadAll = () => {
      // DSH 插件 effect 清理回调，LIFO
      while (state.cleanups.length) {
        try {
          state.cleanups.pop()();
        } catch (err) {
          console.error('[dsh-compat] DSH 插件清理回调失败:', err);
        }
      }
      for (const root of state.roots) {
        try {
          root.unmount();
        } catch {}
      }
      state.roots.length = 0;
      for (const root of state.sectionRoots) {
        try {
          root.unmount();
        } catch {}
      }
      state.sectionRoots.length = 0;
      for (const root of state.dockRoots) {
        try {
          root.unmount();
        } catch {}
      }
      state.dockRoots.length = 0;
      if (state.dockEl) {
        try {
          state.dockEl.remove();
        } catch {}
        state.dockEl = null;
      }
      if (state.mainPanelEl) {
        try {
          state.mainPanelRoot?.unmount();
        } catch {}
        state.mainPanelRoot = null;
        try {
          state.mainPanelEl.remove();
        } catch {}
        state.mainPanelEl = null;
      }
      for (const el of state.overlayEls) {
        try {
          el.remove();
        } catch {}
      }
      state.overlayEls.length = 0;
      state.statuses.clear();
      state.settingsSections.clear();
      state.sidebarItems.clear();
      state.mainPanels.clear();
      state.unknownServices.clear();
    };
    state.unloadAll = unloadAll;

    // ---- window.__ModuleLoader__ 垫片：先装垫片再注入脚本 ----
    const ensureModuleLoader = () => {
      const existing = window.__ModuleLoader__;
      if (existing && existing[LOADER_MARK] === true) {
        state.loaderOwned = false;
        return existing._queue;
      }
      const queue = [];
      const loader = {
        [LOADER_MARK]: true,
        _queue: queue,
        load(mod) {
          if (mod && typeof mod.factory === 'function') queue.push(mod);
          else console.warn('[dsh-compat] __ModuleLoader__.load 收到无效载荷:', mod);
        }
      };
      window.__ModuleLoader__ = loader;
      state.loaderOwned = true;
      console.log('[dsh-compat] window.__ModuleLoader__ 垫片已安装');
      return queue;
    };

    // ---- 发现 DSH 包：listDir 列目录 + 逐包读 package.json ----
    const fetchPackageJson = async (dirName) => {
      // 优先 fetch（zmod-local 协议注册了 supportFetchAPI）；失败兜底走主进程 RPC
      try {
        const res = await fetch(
          `zmod-local://plugins/${PLUGIN_ID}/${DSH_DIR}/${encodeURIComponent(dirName)}/package.json`,
          { cache: 'no-store' }
        );
        if (res.ok) return JSON.parse(await res.text());
      } catch {}
      try {
        const r = await invoke('plugin.readAsset', {
          pluginId: PLUGIN_ID,
          relPath: `${DSH_DIR}/${dirName}/package.json`
        });
        if (r && r.ok) {
          return JSON.parse(
            new TextDecoder().decode(Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)))
          );
        }
      } catch {}
      return null;
    };

    const discoverPackages = async () => {
      let entries = [];
      try {
        const res = await invoke('plugin.listDir', { pluginId: PLUGIN_ID, relPath: DSH_DIR });
        if (res && res.ok) entries = res.entries || [];
        else console.warn('[dsh-compat] plugin.listDir 失败:', res && res.error);
      } catch (err) {
        // 主进程未重启或老基座无该 RPC：降级提示并支持手动输入包名自愈
        console.warn('[dsh-compat] plugin.listDir 暂不可用（可使用 packageList 设置项手动指定）:', err?.message || err);
      }

      // 手动包名自愈降级：当基座不支持 listDir 时，允许在设置项中输入包名直接加载
      const manualRaw = s.get('packageList', '');
      if (manualRaw && typeof manualRaw === 'string') {
        const names = manualRaw.split(/[,;\s]+/).map((str) => str.trim()).filter(Boolean);
        for (const name of names) {
          if (!entries.some((e) => e.name === name)) {
            entries.push({ name, type: 'dir' });
          }
        }
      }

      const manifests = {};
      for (const entry of entries) {
        if (entry.type !== 'dir') continue;
        manifests[entry.name] = await fetchPackageJson(entry.name);
        if (!manifests[entry.name]) {
          console.warn(`[dsh-compat] ${entry.name}/package.json 不可读，该包跳过`);
        }
      }
      return filterLoadablePackages(entries, manifests);
    };

    // ---- DSH 槽位调度与 UI 容器（DSH Dock + Main Viewport） ----
    const registerSlotItem = (pkgName, item) => {
      const meta = item.meta || {};
      const slotName = meta.name;
      if (slotName === 'sidebar.panellist') {
        const list = state.sidebarItems.get(pkgName) || [];
        if (!list.some((r) => (r.meta?.id || r.meta?.name) === (meta.id || meta.name))) {
          list.push(item);
          state.sidebarItems.set(pkgName, list);
          repaintDock();
          state.repaintSettings?.();
        }
      } else if (slotName === 'main') {
        const list = state.mainPanels.get(pkgName) || [];
        if (!list.some((r) => (r.meta?.key || r.meta?.name) === (meta.key || meta.name))) {
          list.push(item);
          state.mainPanels.set(pkgName, list);
          state.repaintSettings?.();
          const active = state.layoutService?.getActivePanelId();
          if (active && (meta.key === active || meta.id === active)) {
            renderMainPanel(active);
          }
        }
      } else if (slotName === 'settings.section') {
        const list = state.settingsSections.get(pkgName) || [];
        if (!list.some((r) => (r.meta?.id || r.meta?.name) === (meta.id || meta.name))) {
          list.push(item);
          state.settingsSections.set(pkgName, list);
          state.repaintSettings?.();
        }
      }
    };

    const unregisterSlotItem = (pkgName, item) => {
      const meta = item.meta || {};
      const slotName = meta.name;
      if (slotName === 'sidebar.panellist') {
        const list = state.sidebarItems.get(pkgName) || [];
        const i = list.indexOf(item);
        if (i >= 0) list.splice(i, 1);
        repaintDock();
        state.repaintSettings?.();
      } else if (slotName === 'main') {
        const list = state.mainPanels.get(pkgName) || [];
        const i = list.indexOf(item);
        if (i >= 0) list.splice(i, 1);
        state.repaintSettings?.();
        const active = state.layoutService?.getActivePanelId();
        if (active && (meta.key === active || meta.id === active)) {
          state.layoutService.selectPanel(null);
        }
      } else if (slotName === 'settings.section') {
        const list = state.settingsSections.get(pkgName) || [];
        const i = list.indexOf(item);
        if (i >= 0) list.splice(i, 1);
        state.repaintSettings?.();
      }
    };

    const dockEnabled = () => { try { return s.get('dockEnabled', false) === true; } catch { return false; } };
    const repaintDock = () => {
      if (!dockEnabled()) {
        if (state.dockEl) { for (const r of state.dockRoots) { try { r.unmount(); } catch {} } state.dockRoots.length = 0; state.dockEl.remove(); state.dockEl = null; }
        return;
      }
      const allItems = [];
      for (const [pkgName, items] of state.sidebarItems) {
        for (const item of items) {
          allItems.push({ pkgName, ...item });
        }
      }
      if (!allItems.length) {
        if (state.dockEl) {
          for (const root of state.dockRoots) {
            try { root.unmount(); } catch {}
          }
          state.dockRoots.length = 0;
          state.dockEl.remove();
          state.dockEl = null;
        }
        return;
      }

      let portal = document.getElementById(PORTAL_ID);
      if (!portal) {
        portal = document.createElement('div');
        portal.id = PORTAL_ID;
        portal.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147480000;';
        (document.body || document.documentElement).appendChild(portal);
      }

      for (const root of state.dockRoots) {
        try { root.unmount(); } catch {}
      }
      state.dockRoots.length = 0;

      if (!state.dockEl) {
        state.dockEl = document.createElement('div');
        state.dockEl.id = 'zmod-dsh-dock';
        state.dockEl.style.cssText =
          'position:fixed;left:10px;top:50%;transform:translateY(-50%);z-index:2147481000;' +
          'pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:6px;' +
          'padding:8px 6px;background:rgba(24,24,27,0.92);backdrop-filter:blur(16px);' +
          '-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.12);' +
          'border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,0.45);user-select:none;transition:all 0.2s ease;';
        portal.appendChild(state.dockEl);
      } else {
        state.dockEl.innerHTML = '';
      }

      const badge = document.createElement('div');
      badge.style.cssText =
        'font-size:9px;font-weight:700;letter-spacing:0.06em;color:rgba(255,255,255,0.4);' +
        'padding:1px 4px;margin-bottom:2px;cursor:default;';
      badge.textContent = 'DSH';
      badge.title = 'DSH 插件活动坞 (Activity Dock)';
      state.dockEl.appendChild(badge);

      const activeId = state.layoutService?.getActivePanelId();

      for (const entry of sortSlots(allItems)) {
        const id = entry.meta?.id || entry.meta?.key;
        const label =
          typeof entry.meta?.label === 'function' ? entry.meta.label() : entry.meta?.label || id;
        const isActive = activeId === id;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = label;
        btn.style.cssText =
          'width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;' +
          'cursor:pointer;transition:all 0.15s ease;border:1px solid ' +
          (isActive ? 'rgba(129,140,248,0.5)' : 'transparent') + ';' +
          'background:' +
          (isActive ? 'rgba(99,102,241,0.25)' : 'transparent') + ';' +
          (isActive ? 'box-shadow:0 0 10px rgba(99,102,241,0.35);' : '');

        btn.addEventListener('mouseenter', () => {
          if (state.layoutService?.getActivePanelId() !== id) {
            btn.style.background = 'rgba(255,255,255,0.08)';
          }
        });
        btn.addEventListener('mouseleave', () => {
          if (state.layoutService?.getActivePanelId() !== id) {
            btn.style.background = 'transparent';
          }
        });

        btn.addEventListener('click', () => {
          if (state.layoutService?.getActivePanelId() === id) {
            state.layoutService.selectPanel(null);
          } else {
            state.layoutService.selectPanel(id);
          }
        });

        const iconWrap = document.createElement('div');
        iconWrap.style.cssText =
          'display:flex;align-items:center;justify-content:center;pointer-events:none;';
        btn.appendChild(iconWrap);
        state.dockEl.appendChild(btn);

        if (state.ReactDOM && typeof entry.render === 'function') {
          try {
            const root = state.ReactDOM.createRoot(iconWrap);
            const vnode = entry.render({ size: 18 });
            if (vnode) root.render(vnode);
            state.dockRoots.push(root);
          } catch (e) {
            console.error('[dsh-compat] 渲染 Dock 图标失败:', e);
          }
        }
      }
    };

    const renderMainPanel = (activeId) => {
      if (!activeId) {
        if (state.mainPanelEl) {
          try {
            state.mainPanelRoot?.unmount();
          } catch {}
          state.mainPanelRoot = null;
          state.mainPanelEl.remove();
          state.mainPanelEl = null;
        }
        return;
      }

      let targetReg = null;
      let targetPkg = '';
      for (const [pkgName, panels] of state.mainPanels) {
        for (const p of panels) {
          if ((p.meta?.key || p.meta?.id) === activeId) {
            targetReg = p;
            targetPkg = pkgName;
            break;
          }
        }
        if (targetReg) break;
      }

      if (!targetReg) {
        console.warn(`[dsh-compat] 未找到 key=${activeId} 的 DSH main 面板`);
        return;
      }

      let label = activeId;
      for (const [, items] of state.sidebarItems) {
        for (const item of items) {
          if ((item.meta?.id || item.meta?.key) === activeId) {
            label =
              typeof item.meta?.label === 'function' ? item.meta.label() : item.meta?.label || label;
            break;
          }
        }
      }

      let portal = document.getElementById(PORTAL_ID);
      if (!portal) {
        portal = document.createElement('div');
        portal.id = PORTAL_ID;
        portal.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147480000;';
        (document.body || document.documentElement).appendChild(portal);
      }

      if (state.mainPanelEl) {
        try {
          state.mainPanelRoot?.unmount();
        } catch {}
        state.mainPanelRoot = null;
        state.mainPanelEl.remove();
        state.mainPanelEl = null;
      }

      const backdrop = document.createElement('div');
      backdrop.id = 'zmod-dsh-viewport-backdrop';
      backdrop.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,0.58);backdrop-filter:blur(8px);' +
        '-webkit-backdrop-filter:blur(8px);z-index:2147482000;display:flex;align-items:center;' +
        'justify-content:center;pointer-events:auto;animation:fadeIn 0.15s ease-out;';

      const winBox = document.createElement('div');
      winBox.style.cssText =
        'width:min(1100px, 94vw);height:min(820px, 90vh);background:#18181b;border:1px solid rgba(255,255,255,0.15);' +
        'border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,0.7);display:flex;flex-direction:column;' +
        'overflow:hidden;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

      const titleBar = document.createElement('div');
      titleBar.style.cssText =
        'height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;' +
        'border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);user-select:none;';

      const leftWrap = document.createElement('div');
      leftWrap.style.cssText = 'display:flex;align-items:center;gap:10px;';

      const dshTag = document.createElement('span');
      dshTag.style.cssText =
        'background:rgba(99,102,241,0.2);color:#a5b4fc;font-size:10px;font-weight:700;padding:2px 6px;border-radius:6px;border:1px solid rgba(99,102,241,0.3);';
      dshTag.textContent = 'DSH';

      const titleEl = document.createElement('span');
      titleEl.style.cssText = 'font-weight:600;font-size:14px;color:#f4f4f5;';
      titleEl.textContent = label;

      const subPkg = document.createElement('span');
      subPkg.style.cssText = 'font-size:12px;color:#71717a;';
      subPkg.textContent = `(${targetPkg})`;

      leftWrap.appendChild(dshTag);
      leftWrap.appendChild(titleEl);
      leftWrap.appendChild(subPkg);
      titleBar.appendChild(leftWrap);

      const rightWrap = document.createElement('div');
      rightWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.style.cssText =
        'background:transparent;border:none;color:#a1a1aa;cursor:pointer;padding:4px 8px;border-radius:6px;font-size:12px;transition:all 0.15s;';
      refreshBtn.textContent = '刷新';
      refreshBtn.addEventListener('mouseenter', () => (refreshBtn.style.color = '#f4f4f5'));
      refreshBtn.addEventListener('mouseleave', () => (refreshBtn.style.color = '#a1a1aa'));
      refreshBtn.addEventListener('click', () => {
        renderMainPanel(activeId);
      });

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.style.cssText =
        'background:transparent;border:none;color:#a1a1aa;cursor:pointer;width:28px;height:28px;border-radius:6px;font-size:18px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;';
      closeBtn.innerHTML = '×';
      closeBtn.title = '关闭 (Esc)';
      closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = 'rgba(239,68,68,0.2)';
        closeBtn.style.color = '#ef4444';
      });
      closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = 'transparent';
        closeBtn.style.color = '#a1a1aa';
      });
      closeBtn.addEventListener('click', () => {
        state.layoutService?.selectPanel(null);
      });

      rightWrap.appendChild(refreshBtn);
      rightWrap.appendChild(closeBtn);
      titleBar.appendChild(rightWrap);
      winBox.appendChild(titleBar);

      const bodyEl = document.createElement('div');
      bodyEl.style.cssText = 'flex:1;overflow-y:auto;position:relative;background:#18181b;';
      winBox.appendChild(bodyEl);
      backdrop.appendChild(winBox);
      portal.appendChild(backdrop);
      state.mainPanelEl = backdrop;

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          state.layoutService?.selectPanel(null);
        }
      });

      if (state.ReactDOM && typeof targetReg.render === 'function') {
        try {
          const root = state.ReactDOM.createRoot(bodyEl);
          state.mainPanelRoot = root;
          const vnode = targetReg.render();
          if (vnode) root.render(vnode);
        } catch (err) {
          console.error(`[dsh-compat] 渲染 main 面板 ${activeId} 失败:`, err);
          bodyEl.innerHTML = `<div style="padding:20px;color:#ef4444;">渲染面板失败: ${err?.message || err}</div>`;
        }
      }
    };

    state.layoutService.panelInfo.subscribe(() => {
      const active = state.layoutService.getActivePanelId();
      renderMainPanel(active);
      repaintDock();
    });

    const handleKeydown = (e) => {
      if (e.key === 'Escape' && state.layoutService?.getActivePanelId()) {
        state.layoutService.selectPanel(null);
      }
    };
    window.addEventListener('keydown', handleKeydown);

    const makeSlotsService = (pkgName) => {
      const slotRegistry = [];
      return {
        inject(slotName, genFn) {
          const registrations = [];
          try {
            const it = typeof genFn === 'function' ? genFn() : null;
            if (it && typeof it[Symbol.iterator] === 'function') {
              for (const reg of it) registrations.push(reg);
            }
          } catch (err) {
            console.error(`[dsh-compat] ${pkgName} slots.inject('${slotName}') 执行失败:`, err);
          }
          for (const reg of slotRegistry) {
            if (reg.meta?.name === slotName && !registrations.includes(reg)) {
              registrations.push(reg);
            }
          }
          handleSlotRegistrations(pkgName, slotName, registrations);
        },
        register(meta, renderFn) {
          const item = { meta: meta || {}, render: renderFn };
          slotRegistry.push(item);
          registerSlotItem(pkgName, item);
          return () => {
            const idx = slotRegistry.indexOf(item);
            if (idx >= 0) slotRegistry.splice(idx, 1);
            unregisterSlotItem(pkgName, item);
          };
        }
      };
    };

    const handleSlotRegistrations = (pkgName, slotName, registrations) => {
      if (!registrations.length) return;
      if (slotName === 'settings.section') {
        for (const reg of registrations) registerSlotItem(pkgName, reg);
        console.log(`[dsh-compat] ${pkgName} 注册设置分区: ${registrations.length} 项`);
        state.repaintSettings?.();
        return;
      }
      if (slotName === 'sidebar.panellist') {
        for (const reg of registrations) registerSlotItem(pkgName, reg);
        console.log(`[dsh-compat] ${pkgName} 注册侧栏活动项: ${registrations.length} 项`);
        repaintDock();
        state.repaintSettings?.();
        return;
      }
      if (slotName === 'main') {
        for (const reg of registrations) registerSlotItem(pkgName, reg);
        console.log(`[dsh-compat] ${pkgName} 注册主视窗面板: ${registrations.length} 项`);
        state.repaintSettings?.();
        const active = state.layoutService?.getActivePanelId();
        if (active && registrations.some((r) => (r.meta?.key || r.meta?.id) === active)) {
          renderMainPanel(active);
        }
        return;
      }
      if (slotName !== 'shell.overlay') {
        console.info(
          `[dsh-compat] ${pkgName} 注册的槽位 '${slotName}'（${registrations.length} 项）在 ZMod 暂无对应渲染面，跳过`
        );
        return;
      }
      // shell.overlay：页面覆盖层，挂 #zmod-mount-portal（无则 body 直挂），
      // 严禁进 React 主树 #root
      let portal = document.getElementById(PORTAL_ID);
      if (!portal) {
        portal = document.createElement('div');
        portal.id = PORTAL_ID;
        portal.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147480000;';
        (document.body || document.documentElement).appendChild(portal);
      }
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482000;';
      wrap.setAttribute('data-dsh-compat', pkgName);
      portal.appendChild(wrap);
      state.overlayEls.push(wrap);
      for (const reg of sortSlots(registrations)) {
        const host = document.createElement('div');
        host.style.pointerEvents = 'auto';
        wrap.appendChild(host);
        try {
          const root = state.ReactDOM.createRoot(host);
          const vnode = typeof reg.render === 'function' ? reg.render() : null;
          if (vnode) {
            root.render(vnode);
            state.roots.push(root);
          }
        } catch (err) {
          console.error(
            `[dsh-compat] ${pkgName} 槽位项渲染失败 (meta=${JSON.stringify(reg.meta)}):`,
            err
          );
        }
      }
      console.log(`[dsh-compat] ${pkgName} → shell.overlay × ${registrations.length}`);
    };

    const makeServiceStub = (pkgName, svcName) => {
      if (svcName === 'slots') return makeSlotsService(pkgName);
      if (svcName === 'locale') return state.localeService;
      if (svcName === 'connection') {
        return { state: 'connected', on() { return () => {}; }, off() {}, once() {} };
      }
      if (svcName === 'theme') {
        return state.themeService;
      }
      if (svcName === 'layout') {
        return state.layoutService;
      }
      if (svcName === 'pluginNavigation') {
        return {
          openBundle: () => {}
        };
      }
      if (svcName === 'settingsScope') {
        return {};
      }
      // remote / remote.commands / commandUi / 其他未知服务：空对象降级
      state.unknownServices.add(svcName);
      return {};
    };

    // ---- 装载单个包 ----
    const mountPackage = (pkg, mod) => {
      const module = mod.factory(state.requireFor);
      const { apply, inject, name } = module || {};
      if (typeof apply !== 'function') {
        throw new Error(`factory 返回的 module 缺少 apply (name=${String(name)})`);
      }
      const dshCleanups = [];
      const dshCtx = createDshContext(state.servicesBag, dshCleanups);
      const injectList = Array.isArray(inject) ? inject : [];
      for (const svcName of injectList) {
        // slots 是按包隔离的注册通道（注册项归属哪个插件、面板归属哪行、卸载清理全部
        // 依赖 pkgName），严禁进共享服务袋——否则先装载包的 slots 会被后续包复用，
        // 其注册项全部错记到先装载包名下（dshmarket 面板错挂到 dsh-pet 行）。
        if (svcName === 'slots') {
          dshCtx.slots = makeSlotsService(pkg.name);
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(state.servicesBag, svcName)) {
          state.servicesBag[svcName] = makeServiceStub(pkg.name, svcName);
        }
        dshCtx[svcName] = state.servicesBag[svcName];
      }
      apply(dshCtx);
      // 包内 effect 清理回调压入全局栈；整体 LIFO 弹出时保持包内注册的逆序
      state.cleanups.push(...dshCleanups);
      console.log(
        `[dsh-compat] ${pkg.displayName || pkg.name} 已装载 (inject: ${injectList.join(', ') || '无'})`
      );
    };

    const loadPackage = async (pkg) => {
      if (!state.isPkgEnabled(pkg.name)) {
        state.statuses.set(pkg.name, 'disabled');
        console.info(`[dsh-compat] ${pkg.name} 已在设置中停用，跳过`);
        return;
      }
      if (!pkg.clientPath) {
        state.statuses.set(pkg.name, 'error');
        console.warn(`[dsh-compat] ${pkg.name} 仅有 dsh.client 声明、无可注入的 client 脚本路径，跳过`);
        return;
      }
      const queue = state.loaderQueue || (state.loaderQueue = ensureModuleLoader());
      const before = Array.isArray(queue) ? queue.length : 0;
      const url =
        `zmod-local://plugins/${PLUGIN_ID}/${DSH_DIR}/${encodeURIComponent(pkg.name)}/${pkg.clientPath}` +
        `?v=${encodeURIComponent(pkg.version || '0')}`;
      try {
        const el = await loadScript(url);
        state.scripts.push(el);
      } catch (err) {
        console.error(`[dsh-compat] ${pkg.name} client 脚本加载失败:`, err?.message || err);
        state.statuses.set(pkg.name, 'error');
        toastOnce(`DSH 插件 ${pkg.name} 脚本加载失败（详见控制台）`, 'error');
        return;
      }
      // 脚本异步执行，onload 后从收集队列取该 id 的 factory
      const fresh = queue.slice(before);
      const mod = fresh.find((m) => m && m.id === pkg.name) || fresh[fresh.length - 1];
      if (!mod || typeof mod.factory !== 'function') {
        console.error(`[dsh-compat] ${pkg.name} 未通过 __ModuleLoader__.load({id, factory}) 注册工厂`);
        state.statuses.set(pkg.name, 'error');
        toastOnce(`DSH 插件 ${pkg.name} 未注册插件工厂（详见控制台）`, 'error');
        return;
      }
      try {
        mountPackage(pkg, mod);
        state.statuses.set(pkg.name, 'loaded');
      } catch (err) {
        console.error(`[dsh-compat] ${pkg.name} 装载失败:`, err);
        state.statuses.set(pkg.name, 'error');
        toastOnce(`DSH 插件 ${pkg.name} 装载失败（详见控制台）`, 'error');
      }
    };

    // ---- 主流程：vendor → 垫片 → 发现 → 装载 ----
    const runAll = async () => {
      if (s.get('enabled', true) === false) {
        console.info('[dsh-compat] 总开关已关闭，跳过 DSH 插件装载');
        return;
      }
      try {
        const v = String(Date.now());
        state.scripts.push(await loadScript(`zmod-local://plugins/${PLUGIN_ID}/vendor/react.js?v=${v}`));
        state.scripts.push(
          await loadScript(`zmod-local://plugins/${PLUGIN_ID}/vendor/react-dom.js?v=${v}`)
        );
      } catch (err) {
        console.error('[dsh-compat] vendor React 加载失败:', err?.message || err);
        console.error(
          '[dsh-compat] 修复方法：下载 React 18 UMD 构建产物 ' +
            '(react.production.min.js / react-dom.production.min.js)，' +
            '分别改名 react.js / react-dom.js 放入 <数据目录>/plugins/dsh-compat/vendor/ 后重新扫描'
        );
        toastOnce('dsh-compat：vendor React 缺失，DSH 插件未装载（修复方法见控制台）', 'error');
        return;
      }
      state.React = window.React;
      state.ReactDOM = window.ReactDOM;
      if (!state.React || !state.ReactDOM || typeof state.ReactDOM.createRoot !== 'function') {
        console.error('[dsh-compat] vendor 脚本已加载但 window.React/ReactDOM 不完整，中止');
        toastOnce('dsh-compat：vendor React 不完整，DSH 插件未装载', 'error');
        return;
      }
      state.requireFor = buildRequireTable(state.React, state.ReactDOM, {});
      state.loaderQueue = ensureModuleLoader();

      const packages = await discoverPackages();
      state.discovered = packages;
      for (const pkg of packages) {
        if (!pkg.loadable) {
          state.statuses.set(pkg.name, 'host-only');
          console.info(
            `[dsh-compat] ${pkg.name} 跳过：${SKIP_REASON_LABEL[pkg.reason] || pkg.reason}`
          );
          continue;
        }
        try {
          await loadPackage(pkg);
        } catch (pkgErr) {
          console.error(`[dsh-compat] ${pkg.name} 异常隔离拦截:`, pkgErr);
          state.statuses.set(pkg.name, 'error');
        }
      }
      if (state.unknownServices.size) {
        console.warn(
          `[dsh-compat] 以下 DSH 服务未提供、以空对象降级（相关插件界面在但数据不可用）: ` +
            [...state.unknownServices].join(', ')
        );
      }
      console.log(`[dsh-compat] 扫描完成：发现 ${packages.length} 个包，装载 ${state.loadedCount()} 个`);
      state.repaintSettings?.();

      // 联动桌面 Helper：若配置包含 desktop/both 宠物，由主进程拉起透明桌面窗口
      try {
        const userCfg = s.get('petUserConfig', null);
        const activeCfg = userCfg
          ? {
              ...DEFAULT_PET_CONFIG,
              ...userCfg,
              animations: DEFAULT_PET_CONFIG.animations,
              animationWeights: DEFAULT_PET_CONFIG.animationWeights,
              eventsRefreshSec: DEFAULT_PET_CONFIG.eventsRefreshSec
            }
          : DEFAULT_PET_CONFIG;
        invoke('dsh.syncHelper', { activeConfig: activeCfg, enabled: true }).catch(() => {});
      } catch {}
    };
    state.runAll = runAll;

    // 总开关关闭 → 立即卸载（开启方向不自动装载，走"重新扫描并装载"）
    try {
      s.onChange?.('enabled', (v) => {
        if (v === false) {
          unloadAll();
          invoke('dsh.stopHelper', {}).catch(() => {});
          console.info('[dsh-compat] 总开关关闭，已卸载全部 DSH 插件');
        }
      });
    } catch {}

    // 终局清理：卸载 DSH 插件 → 移除注入 script → 删除自装的 ModuleLoader → 还原 fetch
    cleanup(() => {
      window.removeEventListener('keydown', handleKeydown);
      window.fetch = origFetch;
      unloadAll();
      invoke('dsh.stopHelper', {}).catch(() => {});
      for (const el of state.scripts) {
        try {
          el.remove();
        } catch {}
      }
      state.scripts.length = 0;
      if (state.loaderOwned) {
        try {
          delete window.__ModuleLoader__;
        } catch {}
      }
      if (runtime === state) runtime = null;
    });

    await runAll();
  }
});
