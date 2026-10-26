/**
 * ZMod → official Settings page integration.
 *
 * Two modes, picked per settings-dialog mount:
 *
 *  NATIVE (preferred) — we register real sections in the host's own settings
 *  registry, so the sidebar item, its selection highlight, the page title, the
 *  scroll container and the content column are all the host's own React output.
 *  The host renders nothing for unknown section ids, which is exactly where we
 *  mount our content. Discovery is structural (React internals reached through
 *  the DOM's fiber pointer, never minified identifiers), and every registration
 *  is verified — on any doubt we undo and fall back to the overlay.
 *
 *  OVERLAY (fallback) — our own nav group is appended to the official sidebar
 *  and our content is painted over the official content column, with the host's
 *  own selection highlight neutralised by CSS so only one item ever reads as
 *  selected.
 *
 * Hard rules learned from the v1 era:
 *  - NEVER mutate the official React-managed DOM (no insertBefore into
 *    React-owned containers, no hiding official nodes) — the reconciler
 *    re-renders forever. We only append our own subtree and overlay.
 *  - Nav discovery is locale-independent: official nav items carry
 *    [data-settings-section-nav]; the content column sits in
 *    [data-settings-panel-frame]; the settings root carries [data-active-section].
 *  - Class names below are the host's own Tailwind token vocabulary, so the
 *    result follows theme changes for free.
 */

/* ---- lucide icons, 16px stroke=currentColor to match host icon set ---- */
const ICONS = {
  puzzle:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 3c0.9 0 1.6 0.7 1.6 1.6V7c0 0.6-0.4 1-1 1h-1.2c-0.6 0-1 0.4-1 1s0.4 1 1 1H21c0.6 0 1 0.4 1 1v0.4"></path><path d="M21 15v3.4c0 0.9-0.7 1.6-1.6 1.6H4.6C3.7 20 3 19.3 3 18.4V4.6C3 3.7 3.7 3 4.6 3H11c0.6 0 1 0.4 1 1v1.4c0 0.6 0.4 1 1 1s1-0.4 1-1V4c0-0.6 0.4-1 1-1h3z"></path></svg>',
  database:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14a9 3 0 0 0 18 0V5"></path><path d="M3 12a9 3 0 0 0 18 0"></path></svg>',
  gear:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
  refresh:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>',
  plus:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>',
  pencil:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path><path d="m15 5 4 4"></path></svg>',
  trash:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>',
  chevronRight:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>'
};

function iconHtml(name, cls = 'size-4') {
  return ICONS[name].replace('<svg ', `<svg class="${cls}" `);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

/* ------------------------------------------------------------------ *
 * 拖放安装纯函数（export 供 Node 单测离线验证，无 DOM 依赖）
 * ------------------------------------------------------------------ */

/** 递归收集时跳过的目录名（依赖噪声，不属于插件本体）。 */
export const DROP_SKIP_DIR_NAMES = ['node_modules', '.git'];

/** 渲染层预检的插件包总量上限（主进程 plugin.installUpload 还有同值兜底）。 */
export const DROP_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** ArrayBuffer → base64：按 32KB 分块 String.fromCharCode，避免大文件爆栈。 */
export function arrayBufferToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/**
 * 递归展开 webkitGetAsEntry 目录树，收集 [{path,b64}] 文件清单。
 * entry 只需实现 {isDirectory,isFile,name,file(cb[,errCb]),createReader()} 协议，
 * createReader() 返回 {readEntries(ok[,errCb])}（每批若干条，空批即尽）——
 * 真实 File System API 与 mock 树同协议。
 * - 跳过 DROP_SKIP_DIR_NAMES 目录；
 * - 累计字节数超过 maxBytes 抛 {code:'DROP_TOO_LARGE'}；
 * - 单个条目读取失败走 onError 旁路（默认吞掉）继续收集其余文件。
 */
export async function collectFilesFromEntry(entry, { maxBytes = DROP_MAX_TOTAL_BYTES, onError } = {}) {
  const files = [];
  let total = 0;
  const walk = async (ent, prefix) => {
    if (ent.isDirectory) {
      if (DROP_SKIP_DIR_NAMES.includes(ent.name)) return;
      const reader = ent.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch || batch.length === 0) break;
        for (const child of batch) {
          try {
            await walk(child, prefix ? `${prefix}/${child.name}` : child.name);
          } catch (err) {
            if (err?.code === 'DROP_TOO_LARGE') throw err;
            try { onError?.(err); } catch {}
          }
        }
      }
      return;
    }
    if (ent.isFile) {
      const file = await new Promise((resolve, reject) => ent.file(resolve, reject));
      const bytes = new Uint8Array(await file.arrayBuffer());
      total += bytes.length;
      if (total > maxBytes) {
        const err = new Error(`插件包过大（> ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限）`);
        err.code = 'DROP_TOO_LARGE';
        throw err;
      }
      files.push({ path: prefix || ent.name, b64: arrayBufferToBase64(bytes) });
    }
  };
  try {
    await walk(entry, '');
  } catch (err) {
    if (err?.code === 'DROP_TOO_LARGE') throw err;
    try { onError?.(err); } catch {}
  }
  return files;
}

/**
 * 同步分拣拖入项 → 安装任务列表（批量拖入的第一步）。
 * items 是 DataTransferItemList 形状的 array-like——真实 DOM 对象不可迭代
 * （无 Symbol.iterator），只能索引遍历；测试传普通数组同样成立。
 * DataTransferItem 在事件循环让出后即失效：本函数必须纯同步，调用方必须
 * 在任何 await 之前一次性完成收集，之后再逐个异步读取内容。
 * - 目录项（webkitGetAsEntry().isDirectory）→ {kind:'dir', name, entry}
 * - .zip 文件项（getAsFile()）→ {kind:'zip', name, file}
 * - 其余（散文件 / 非 zip）不计任务，名字进 skippedNames 供提示点名
 */
export function collectDropTasks(items) {
  const tasks = [];
  const skippedNames = [];
  for (let i = 0; items && i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) {
      tasks.push({ kind: 'dir', name: entry.name, entry });
      continue;
    }
    const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    if (file && /\.zip$/i.test(file.name || '')) {
      tasks.push({ kind: 'zip', name: file.name, file });
      continue;
    }
    skippedNames.push(file?.name || entry?.name || `#${i}`);
  }
  return { tasks, skippedNames };
}

/* Official nav item classes, verbatim from the host settings sidebar. */
const NAV_BTN_BASE =
  'flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors ' +
  'max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0';
const NAV_BTN_IDLE = 'text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground';
const NAV_BTN_ACTIVE = 'bg-surface-hover text-foreground';

const NAV_ITEMS = [
  { id: 'plugins', label: '扩展插件', icon: 'puzzle' },
  { id: 'datasources', label: '数据源', icon: 'database' }
];

/* ------------------------------------------------------------------ *
 * Native mode constants
 *
 * The host keeps its section registry in module scope with no extension
 * point, and its section-id whitelist (for the "last section" memory) does
 * not know our ids — so we restore our own last-visited section ourselves.
 * ------------------------------------------------------------------ */
const NATIVE_GROUP_ID = 'zmod';
const NATIVE_GROUP_TITLE_ID = 'zmod.settings.group.title';
const NATIVE_MESSAGES = {
  [NATIVE_GROUP_TITLE_ID]: 'ZMod',
  'zmod.settings.plugins.title': '扩展插件',
  'zmod.settings.datasources.title': '数据源'
};
const NATIVE_SECTIONS = [
  { id: 'zmod', itemId: 'plugins', label: '扩展插件', icon: 'puzzle', titleId: 'zmod.settings.plugins.title' },
  { id: 'zmod-datasources', itemId: 'datasources', label: '数据源', icon: 'database', titleId: 'zmod.settings.datasources.title' }
];

/* Official Switch/primary-button classes, verbatim from the host bundle —
   injected classes only have CSS if the official bundle generated it, so
   these must stay byte-identical to the captured strings (with data-size
   and data-state attributes driving the variants). Our earlier hand-rolled
   bg-foreground/text-background pair turned invisible under acrylic because
   text-background is translucent. */
export const OFFICIAL_SWITCH_TRACK =
  'p-px peer group/switch relative inline-flex shrink-0 items-center cursor-pointer rounded-full transition-all outline-none ' +
  'after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-input-border-focused/30 ' +
  'data-[size=default]:h-[18px] data-[size=default]:w-[32px] data-[size=sm]:h-[16px] data-[size=sm]:w-[28px] ' +
  'dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-unchecked:bg-primary/30 ' +
  'data-disabled:cursor-not-allowed data-disabled:opacity-50';
export const OFFICIAL_SWITCH_KNOB =
  'pointer-events-none block rounded-full bg-primary-foreground ring-0 transition-transform ' +
  'group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3.5 ' +
  'group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] ' +
  'group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0';

export function makeSwitch(checked, onChange, toast) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('data-size', 'default');
  const knob = document.createElement('span');
  knob.className = OFFICIAL_SWITCH_KNOB;
  btn.appendChild(knob);
  // knob 的 translate 规则匹配滑块自身的 [data-state]（Ark/Radix thumb
  // 协议），track 上的状态属性不会被那组选择器继承——两处都要设
  const render = (on) => {
    const state = on ? 'checked' : 'unchecked';
    btn.setAttribute('data-state', state);
    btn.setAttribute('aria-checked', String(on));
    knob.setAttribute('data-state', state);
    btn.className = OFFICIAL_SWITCH_TRACK;
  };
  render(checked);
  btn.addEventListener('click', async () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    render(next);
    try {
      await onChange(next);
    } catch (err) {
      render(!next);
      toast?.(`操作失败：${err?.message || err}`, 'error');
    }
  });
  return btn;
}

export function createSettingsPageIntegration({ api, events, registry, datasources, ui }) {
  let observer = null;
  let dialogOpen = false;
  let mode = 'overlay';
  let navEl = null;
  let groupEl = null;
  let navClickHandler = null;
  let overlay = null;
  let activeItem = null;
  let detail = null; // { kind: 'ds-edit', ... }
  const contributions = new Map(); // id -> { id, title, render(el) }

  // Config hot reload: live-refresh an open datasources page instead of
  // requiring the user to close and reopen the settings dialog.
  events.on('zmod:config-changed', () => {
    if (dialogOpen && activeItem === 'datasources' && !detail) {
      try { renderContent(); } catch {}
    }
  });

  // Native mode bookkeeping
  let nativeSupported = null; // null = untried, true = verified, false = give up this session
  let nativeAttempts = 0;
  let nativeReg = null; // { value, intl, sections, undo }
  let nativeMount = null;
  let nativeCrumb = null;
  let nativeCrumbKey = null;
  let nativeRendered = null; // { itemId, detailKey } — what the mount currently shows
  let nativeObserver = null;
  let intentNative = null; // section id left selected when the dialog was last closed

  /* ------------------------------------------------------------ *
   * Sidebar group injection (overlay mode)
   * ------------------------------------------------------------ */
  function scan() {
    const nav = document.querySelector('nav [data-settings-section-nav]')?.closest('nav');
    const frame = document.querySelector('[data-settings-panel-frame]');
    const open = Boolean(nav && frame);
    if (open && !dialogOpen) {
      dialogOpen = true;
      openDialog(nav).catch((err) =>
        console.warn('[ZMod:SettingsPage] settings integration failed:', err?.message || err)
      );
    } else if (!open && dialogOpen) closeDialog();

    if (!dialogOpen) return;
    if (mode === 'native') {
      ensureNativeObserver();
      nativeSync();
    } else if (navEl && activeItem) {
      // Self-heal: if React remounted the dialog while a ZMod view was active,
      // our overlay went down with the old frame — rebuild it.
      if (!overlay || !overlay.isConnected) {
        ensureOverlay();
        renderContent();
      }
    }
  }

  async function openDialog(nav) {
    mode = 'overlay';
    if (nativeSupported !== false && nativeAttempts < 3) {
      if (nativeRegAlive()) {
        mode = 'native';
        ensureNativeMessages();
      } else {
        nativeAttempts += 1;
        const rec = await registerNativeSections();
        if (!dialogOpen) return;
        if (rec) {
          nativeSupported = true;
          nativeReg = rec;
          mode = 'native';
        } else {
          if (nativeAttempts >= 3) nativeSupported = false;
          console.warn(
            `[ZMod:SettingsPage] native section registration unavailable (attempt ${nativeAttempts}/3) — using overlay`
          );
        }
      }
    }
    if (!dialogOpen) return;
    if (mode === 'native') {
      ensureNativeObserver();
      restoreNativeIntent();
      nativeSync();
    } else {
      attachNav(nav);
    }
  }

  function closeDialog() {
    dialogOpen = false;
    nativeObserver?.disconnect();
    nativeObserver = null;
    teardownNativeDom();
    detachNav();
    activeItem = null;
    detail = null;
    nativeRendered = null;
  }

  function attachNav(navArg) {
    if (navEl) return;
    // Registration is awaited, so the dialog may have remounted meanwhile.
    const nav = navArg?.isConnected ? navArg : document.querySelector('nav [data-settings-section-nav]')?.closest('nav');
    if (!nav) return;
    navEl = nav;
    const holder = nav.querySelector('.space-y-4') || nav;

    groupEl = document.createElement('div');
    groupEl.setAttribute('data-zmod-settings-group', 'true');
    groupEl.setAttribute('role', 'group');
    groupEl.setAttribute('aria-labelledby', 'zmod-settings-group-title');
    groupEl.className = 'space-y-1';
    groupEl.innerHTML = `
      <div id="zmod-settings-group-title"
        class="px-2.5 pb-1 text-ui-sm font-medium text-remote-foreground-muted max-lg:sr-only">ZMod</div>`;
    for (const item of NAV_ITEMS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-zmod-nav-item', item.id);
      btn.setAttribute('aria-label', item.label);
      btn.className = `${NAV_BTN_BASE} ${NAV_BTN_IDLE}`;
      btn.innerHTML = `
        <span class="flex size-4 shrink-0 items-center justify-center text-current">${iconHtml(item.icon, 'size-4 text-foreground')}</span>
        <span class="min-w-0 flex-1 max-lg:sr-only"><span class="truncate text-ui-base text-foreground">${esc(item.label)}</span></span>`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activate(item.id);
      });
      groupEl.appendChild(btn);
    }
    holder.appendChild(groupEl);

    // Capture-phase hook: any official nav click exits the ZMod view.
    navClickHandler = (e) => {
      if (e.target.closest('[data-zmod-settings-group]')) return;
      if (activeItem && e.target.closest('[data-settings-section-nav]')) deactivate();
    };
    nav.addEventListener('click', navClickHandler, true);
    console.log('[ZMod:SettingsPage] ZMod group injected into official settings sidebar (overlay mode)');
  }

  function detachNav() {
    if (navClickHandler && navEl) {
      navEl.removeEventListener('click', navClickHandler, true);
      navClickHandler = null;
    }
    groupEl?.remove();
    groupEl = null;
    navEl = null;
    removeOverlay();
  }

  /* ------------------------------------------------------------ *
   * Overlay mode — content painted over the official content column
   * ------------------------------------------------------------ */
  function activate(itemId) {
    activeItem = itemId;
    detail = null;
    for (const item of NAV_ITEMS) {
      const btn = groupEl?.querySelector(`[data-zmod-nav-item="${item.id}"]`);
      if (!btn) continue;
      const on = item.id === itemId;
      btn.className = `${NAV_BTN_BASE} ${on ? NAV_BTN_ACTIVE : NAV_BTN_IDLE}`;
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
    ensureOverlay();
    renderContent();
  }

  function deactivate() {
    activeItem = null;
    detail = null;
    for (const item of NAV_ITEMS) {
      const btn = groupEl?.querySelector(`[data-zmod-nav-item="${item.id}"]`);
      if (btn) {
        btn.className = `${NAV_BTN_BASE} ${NAV_BTN_IDLE}`;
        btn.removeAttribute('aria-current');
      }
    }
    removeOverlay();
  }

  /**
   * The overlay lives INSIDE the official panel frame as an absolutely
   * positioned child (the frame is `position:relative`). This beats a
   * body-level fixed overlay: it aligns itself for free, follows resizes
   * without observers, and dies with the frame when React unmounts the
   * dialog — no stale-overlay states. Above z-50 (Radix dialog layers),
   * below ZMod toasts.
   */
  function ensureOverlay() {
    const frame = document.querySelector('[data-settings-panel-frame]');
    if (!frame) return;
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    overlay.setAttribute('data-zmod-settings-overlay', 'true');
    // Native-section feel: use the theme background token AS-IS — the acrylic
    // plugin's color-mix translucency shows the window material exactly like
    // official sections. The official page beneath is not washed over: the
    // injected stylesheet unpaints it via :has() while the overlay exists.
    overlay.style.cssText =
      'position:absolute;z-index:60;display:flex;flex-direction:column;' +
      'background:var(--color-background);' +
      'left:0;right:0;bottom:0;top:0;';
    frame.appendChild(overlay);
  }

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
  }

  /* ------------------------------------------------------------ *
   * Shared page chrome
   * ------------------------------------------------------------ */

  /** Official settings page title (h2) — rendered by the host in native mode. */
  function pageTitleBlock(text) {
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-wrap items-center justify-between gap-3';
    const h2 = document.createElement('h2');
    h2.className =
      'text-ui-settings-title font-semibold tracking-tight text-foreground lg:text-ui-settings-title-lg';
    h2.textContent = text;
    wrap.appendChild(h2);
    return wrap;
  }

  /** Page body: same vertical rhythm the official lists use. */
  function contentList() {
    const el = document.createElement('div');
    el.className = 'flex flex-col gap-4';
    return el;
  }

  /** Official content column: centred, width-capped, token paddings. */
  function contentColumn() {
    const el = document.createElement('div');
    el.className =
      'mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pb-8 pt-0 lg:px-8 lg:pb-10';
    return el;
  }

  /**
   * The 48px strip above the content column. Official top-level sections show
   * nothing there; drilled-in views show the breadcrumb. It stays a system
   * drag region, like the host's own row, and only the interactive crumb
   * opts out of it.
   */
  function topStrip() {
    const row = document.createElement('div');
    row.className = 'flex h-12 shrink-0';
    row.setAttribute('data-zmod-top-strip', 'true');
    row.style.cssText = '-webkit-app-region:drag;';
    const holder = document.createElement('div');
    holder.className = 'min-w-0 flex-1';
    row.appendChild(holder);
    if (detail) holder.appendChild(crumbEl());
    return row;
  }

  /** Official breadcrumb markup, reduced to the ZMod hierarchy. */
  function crumbEl() {
    const item = NAV_ITEMS.find((i) => i.id === activeItem);
    const nav = document.createElement('nav');
    nav.className = 'pointer-events-none flex h-full min-w-0 items-center overflow-hidden px-2.5';
    nav.setAttribute('data-zmod-crumb', 'true');
    const ol = document.createElement('ol');
    ol.className = 'flex min-w-0 items-center gap-0 overflow-hidden text-ui-base/relaxed';

    const li1 = document.createElement('li');
    li1.className = 'flex min-w-0 items-center';
    const back = document.createElement('button');
    back.type = 'button';
    back.className =
      'pointer-events-auto min-w-0 shrink cursor-pointer text-foreground-subtle transition-colors hover:text-foreground';
    back.style.cssText = '-webkit-app-region:no-drag;';
    back.textContent = `ZMod · ${item?.label || ''}`;
    back.addEventListener('click', () => {
      detail = null;
      renderContent();
    });
    li1.appendChild(back);
    ol.appendChild(li1);

    const sep = document.createElement('li');
    sep.setAttribute('aria-hidden', 'true');
    sep.className = 'flex items-center';
    sep.innerHTML = `<span class="text-foreground-subtlest">${iconHtml('chevronRight', 'size-3.5')}</span>`;
    ol.appendChild(sep);

    const li2 = document.createElement('li');
    li2.className = 'flex min-w-0 items-center px-2';
    const cur = document.createElement('span');
    cur.setAttribute('aria-current', 'page');
    cur.className = 'truncate text-foreground';
    cur.textContent = detail?.title || '';
    li2.appendChild(cur);
    ol.appendChild(li2);

    nav.appendChild(ol);
    return nav;
  }

  /* ------------------------------------------------------------ *
   * Content rendering
   * ------------------------------------------------------------ */
  function renderContent() {
    if (mode === 'native') {
      renderNative();
      return;
    }
    if (!overlay || !activeItem) return;
    overlay.innerHTML = '';
    overlay.appendChild(topStrip());

    const scroll = document.createElement('div');
    scroll.className = 'flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]';
    const col = contentColumn();
    const item = NAV_ITEMS.find((i) => i.id === activeItem);
    if (!detail) col.appendChild(pageTitleBlock(item?.label || ''));
    const body = contentList();
    col.appendChild(body);
    scroll.appendChild(col);
    overlay.appendChild(scroll);

    renderPage(body);
  }

  /** Page bodies are identical in both modes; only the chrome differs. */
  function renderPage(root) {
    if (activeItem === 'plugins') renderPluginsPage(root);
    else renderDatasourcesPage(root);
  }

  /* ------------------------------------------------------------ *
   * Native mode
   * ------------------------------------------------------------ */

  /**
   * React attaches its fiber to every host node; walking up from a sidebar
   * button finds the settings component, whose hook list holds the section
   * registry (a useMemo value) and the host's i18n handle.
   */
  function fiberOf(node) {
    if (!node) return null;
    for (const key in node) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return node[key];
    }
    return null;
  }

  function hookChain(fiber) {
    const out = [];
    let hook = fiber?.memoizedState;
    let guard = 0;
    while (hook && guard++ < 300) {
      out.push(hook);
      hook = hook.next;
    }
    return out;
  }

  function hookValues(fiber) {
    return hookChain(fiber).map((hook) => hook.memoizedState);
  }

  /**
   * Mutating the registry is invisible to React until it renders again. Bump
   * the first numeric state (the settings view's own render counter) through
   * its dispatch queue: no section switch, no navigation intent consumed, no
   * synthetic click — just a scheduled re-render.
   */
  function nudgeRender(fiber) {
    for (const hook of hookChain(fiber)) {
      if (typeof hook?.memoizedState === 'number' && typeof hook.queue?.dispatch === 'function') {
        hook.queue.dispatch((n) => n + 1);
        return true;
      }
    }
    return false;
  }

  const nextPaint = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => setTimeout(resolve, 0))
    );

  function isRegistry(value) {
    return Boolean(
      value &&
        Array.isArray(value.settingsSectionGroups) &&
        Array.isArray(value.settingsSections) &&
        value.settingsSections.some((s) => s && typeof s.id === 'string' && s.groupId)
    );
  }

  /** Newer React stores useMemo as [value, deps]; accept both shapes. */
  function candidates(value) {
    const out = [value];
    if (Array.isArray(value) && value.length === 2) out.push(value[0]);
    return out;
  }

  function findRegistry(startFiber) {
    let fiber = startFiber;
    let guard = 0;
    while (fiber && guard++ < 80) {
      for (const value of hookValues(fiber)) {
        for (const cand of candidates(value)) {
          if (isRegistry(cand)) return { fiber, value: cand };
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  /** The host's useIntl result: { intl, localePreference, … }. */
  function findIntl(fiber) {
    for (const value of hookValues(fiber)) {
      if (!value || typeof value !== 'object') continue;
      const intl = value.intl;
      if (intl && typeof intl.formatMessage === 'function' && intl.messages) return intl;
    }
    return null;
  }

  /** Any live React element works as a shape template for synthesised icons. */
  function findElementTemplate(startFiber) {
    let fiber = startFiber;
    let guard = 0;
    while (fiber && guard++ < 60) {
      const found = searchElement(fiber.pendingProps ?? fiber.memoizedProps, 0);
      if (found) return found;
      fiber = fiber.return;
    }
    return null;
  }

  function searchElement(node, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (node.$$typeof) return node;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = searchElement(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    return searchElement(node.children, depth + 1);
  }

  /** SVG markup uses DOM attribute names; React wants the camelCase prop names. */
  const KEEP_HYPHEN = /^(data-|aria-|xmlns)/;
  function toReactProp(name) {
    if (KEEP_HYPHEN.test(name) || !name.includes('-')) return name;
    return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  /** Build a component that renders one of our SVGs through the host runtime. */
  function makeIcon(template, name) {
    const doc = new DOMParser().parseFromString(ICONS[name], 'image/svg+xml');
    const convert = (node) => {
      const props = {};
      for (const attr of node.attributes) props[toReactProp(attr.name)] = attr.value;
      const kids = [...node.children].map((child, i) => Object.assign(convert(child), { key: `k${i}` }));
      if (kids.length) props.children = kids;
      return Object.assign({}, template, { type: node.nodeName, props });
    };
    const base = convert(doc.documentElement);
    return function ZModSettingsIcon(incoming) {
      return Object.assign({}, base, {
        props: Object.assign({}, base.props, { className: incoming?.className || base.props.className })
      });
    };
  }

  async function registerNativeSections() {
    let undo = null;
    try {
      const navBtn = document.querySelector('nav [data-settings-section-nav]');
      const startFiber = fiberOf(navBtn);
      if (!startFiber) return null;
      const reg = findRegistry(startFiber);
      if (!reg) return null;
      const intl = findIntl(reg.fiber);
      if (!intl || !intl.messages || typeof intl.messages !== 'object') return null;
      const template = findElementTemplate(startFiber);
      if (!template) return null;

      const addedMessages = [];
      for (const [key, value] of Object.entries(NATIVE_MESSAGES)) {
        if (!(key in intl.messages)) addedMessages.push(key);
        intl.messages[key] = value;
      }
      // A missing catalogue entry makes formatMessage echo the id — refuse to
      // register rather than render "zmod.settings.plugins.title" in the nav.
      if (intl.formatMessage({ id: NATIVE_SECTIONS[0].titleId }) === NATIVE_SECTIONS[0].titleId) {
        for (const key of addedMessages) delete intl.messages[key];
        return null;
      }

      const group = { id: NATIVE_GROUP_ID, titleId: NATIVE_GROUP_TITLE_ID, sections: [] };
      const sections = NATIVE_SECTIONS.map((s) => ({
        id: s.id,
        icon: makeIcon(template, s.icon),
        titleId: s.titleId,
        groupId: group.id
      }));
      group.sections = sections.slice();
      reg.value.settingsSectionGroups.push(group);
      reg.value.settingsSections.push(...sections);

      undo = () => {
        const gi = reg.value.settingsSectionGroups.indexOf(group);
        if (gi >= 0) reg.value.settingsSectionGroups.splice(gi, 1);
        for (const s of sections) {
          const i = reg.value.settingsSections.indexOf(s);
          if (i >= 0) reg.value.settingsSections.splice(i, 1);
        }
        for (const key of addedMessages) delete intl.messages[key];
      };

      if (!nudgeRender(reg.fiber)) {
        undo();
        return null;
      }
      await nextPaint();
      if (!document.querySelector(`nav [data-settings-section-nav="${NATIVE_SECTIONS[0].id}"]`)) {
        // One extra frame: the scheduler may have deferred the re-render.
        await nextPaint();
        if (!document.querySelector(`nav [data-settings-section-nav="${NATIVE_SECTIONS[0].id}"]`)) {
          undo();
          return null;
        }
      }
      console.log('[ZMod:SettingsPage] native settings sections registered');
      return { value: reg.value, intl, sections, undo };
    } catch (err) {
      try {
        undo?.();
      } catch {}
      console.warn('[ZMod:SettingsPage] native registration failed:', err?.message || err);
      return null;
    }
  }

  /** True when the live dialog still holds our registration. */
  function nativeRegAlive() {
    if (!nativeReg) return false;
    if (!nativeReg.value.settingsSections.includes(nativeReg.sections[0])) return false;
    return Boolean(document.querySelector(`nav [data-settings-section-nav="${NATIVE_SECTIONS[0].id}"]`));
  }

  /** The host rebuilds its i18n object on provider remounts. */
  function ensureNativeMessages() {
    if (!nativeReg?.intl?.messages) return;
    if (nativeReg.intl.formatMessage({ id: NATIVE_SECTIONS[0].titleId }) === NATIVE_SECTIONS[0].titleId) {
      Object.assign(nativeReg.intl.messages, NATIVE_MESSAGES);
    }
  }

  /**
   * Section ids outside the host's whitelist are dropped from its own
   * "last section" memory, so the selected ZMod section is remembered here and
   * re-applied the next time the dialog opens.
   */
  function restoreNativeIntent() {
    if (!intentNative) return;
    const current = document.querySelector('[data-active-section]')?.getAttribute('data-active-section');
    if (current === intentNative) return;
    document.querySelector(`nav [data-settings-section-nav="${intentNative}"]`)?.click();
  }

  function ensureNativeObserver() {
    const root = document.querySelector('[data-active-section]');
    if (!root || !nativeObserver) {
      nativeObserver?.disconnect();
      nativeObserver = new MutationObserver(() => nativeSync());
    }
    if (root) nativeObserver.observe(root, { attributes: true, attributeFilter: ['data-active-section'] });
  }

  function ensureNativeMount() {
    const host = nativeHost();
    if (!host) return null;
    if (nativeMount && host.contains(nativeMount)) return nativeMount;
    teardownNativeDom();
    nativeMount = document.createElement('div');
    nativeMount.setAttribute('data-zmod-native-mount', 'true');
    host.appendChild(nativeMount);
    nativeRendered = null;
    return nativeMount;
  }

  /** Official content column wrapper: main > mL div > section body div. */
  function nativeHost() {
    const main = document.querySelector('[data-settings-panel-frame] main');
    const body = main?.lastElementChild?.lastElementChild;
    if (!body || !String(body.className || '').includes('space-y-8')) return null;
    return body;
  }

  /** Official breadcrumb holder: frame > column > h-12 row > drag holder. */
  function nativeCrumbHolder() {
    const main = document.querySelector('[data-settings-panel-frame] main');
    const row = main?.parentElement?.firstElementChild;
    if (!row || !String(row.className || '').includes('h-12')) return null;
    return row.firstElementChild || null;
  }

  function detailKey() {
    if (!detail) return '';
    return `${detail.kind}:${detail.id || detail.editing || ''}:${detail.title || ''}`;
  }

  function nativeSync() {
    const root = document.querySelector('[data-active-section]');
    if (!root) return;
    const id = root.getAttribute('data-active-section');
    const section = NATIVE_SECTIONS.find((s) => s.id === id);
    if (!section) {
      intentNative = null;
      teardownNativeDom();
      if (activeItem !== null) {
        activeItem = null;
        detail = null;
      }
      return;
    }
    intentNative = id;
    if (activeItem !== section.itemId) {
      activeItem = section.itemId;
      detail = null;
      nativeRendered = null;
    }
    if (!ensureNativeMount()) return;
    ensureNativeMessages();
    syncNativeCrumb();
    if (nativeRendered?.itemId !== activeItem || nativeRendered?.detailKey !== detailKey()) renderNative();
  }

  function syncNativeCrumb() {
    const key = detail ? detailKey() : '';
    // Rebuild only on change: scan() runs on every DOM mutation, and rebuilding
    // unconditionally would feed itself through the observer.
    if (nativeCrumbKey === key && (!key || nativeCrumb?.isConnected)) return;
    nativeCrumb?.remove();
    nativeCrumb = null;
    nativeCrumbKey = key;
    if (!key) return;
    const holder = nativeCrumbHolder();
    if (!holder) return;
    nativeCrumb = crumbEl();
    nativeCrumb.setAttribute('data-zmod-native-crumb', 'true');
    holder.appendChild(nativeCrumb);
  }

  function renderNative() {
    if (!ensureNativeMount()) return;
    nativeMount.innerHTML = '';
    const body = contentList();
    nativeMount.appendChild(body);
    renderPage(body);
    syncNativeCrumb();
    nativeRendered = { itemId: activeItem, detailKey: detailKey() };
  }

  function teardownNativeDom() {
    nativeMount?.remove();
    nativeMount = null;
    nativeCrumb?.remove();
    nativeCrumb = null;
    nativeCrumbKey = null;
    nativeRendered = null;
  }

  /* ---------------- extensions page ---------------- */

  // 已装插件管理区的行内展开状态（跨重绘保持，切换开关等重绘不折叠）
  let settingsOpenId = null;
  let confirmRemoveId = null;

  function renderPluginsPage(root) {
    renderInstalledPluginsSection(root);

    // 插件自愿贡献的卡片（不动）
    for (const contrib of contributions.values()) {
      const section = document.createElement('section');
      section.className = 'flex flex-col gap-3';
      const title = document.createElement('h3');
      title.className = 'text-ui-sm font-medium text-foreground-subtle';
      title.textContent = contrib.title;
      section.appendChild(title);
      const body = document.createElement('div');
      section.appendChild(body);
      try {
        contrib.render(body, { datasources, registry, api, events, ui });
      } catch (err) {
        body.innerHTML = `<div class="text-ui-sm text-foreground-subtle">渲染失败：${esc(err?.message || err)}</div>`;
      }
      root.appendChild(section);
    }
  }

  /**
   * 已装插件管理区（设置页是插件管理主入口，浮动面板只是保底）。
   * 区头 flex 行：左标题 + 右「添加插件」（开浮动面板市场 tab）。
   * 行卡按启用状态分两组：「已启用 (N)」普通分组；「未启用 (N) · 拖入即装」
   * 是虚线 dropzone，拖 .zip/插件文件夹进来走 plugin.installUpload 安装
   * （默认未启用），列表刷新由 zmod:plugin-changed 广播驱动。
   */
  function renderInstalledPluginsSection(root) {
    const defs = registry.getAll();
    const enabledDefs = defs.filter((d) => registry.isActive(d.id));
    const disabledDefs = defs.filter((d) => !registry.isActive(d.id));

    const section = document.createElement('section');
    section.className = 'flex flex-col gap-3';

    // 区头：左标题 + 右操作
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-3';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'flex min-w-0 flex-col gap-0.5';
    const h3 = document.createElement('h3');
    h3.className = 'text-ui-sm font-medium text-foreground-subtle';
    h3.textContent = `已装插件 (${defs.length})`;
    titleWrap.appendChild(h3);
    const desc = document.createElement('div');
    desc.className = 'text-ui-xs text-foreground-subtle/80';
    desc.textContent = '开关与设置即时生效；移除后配置保留，重新安装默认启用。';
    titleWrap.appendChild(desc);
    header.appendChild(titleWrap);
    header.appendChild(makeAddPluginButton());
    section.appendChild(header);

    // 已启用组：普通分组（无外框），行卡与确认条/设置表单跟随
    const enabledGroup = document.createElement('div');
    enabledGroup.className = 'flex flex-col gap-2';
    enabledGroup.appendChild(groupLabel(`已启用 (${enabledDefs.length})`));
    if (enabledDefs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'py-1 text-ui-sm text-foreground-subtle/70';
      empty.textContent = '暂无已启用插件';
      enabledGroup.appendChild(empty);
    }
    for (const def of enabledDefs) {
      enabledGroup.appendChild(installedPluginRow(def));
      if (confirmRemoveId === def.id) enabledGroup.appendChild(removeConfirmBar(def));
      if (settingsOpenId === def.id) enabledGroup.appendChild(pluginSettingsForm(def));
    }
    section.appendChild(enabledGroup);

    // 未启用组：虚线 dropzone（空态也保留容器 + 提示行）
    section.appendChild(buildDisabledDropzone(disabledDefs));
    root.appendChild(section);
  }

  function groupLabel(text) {
    const el = document.createElement('h3');
    el.className = 'text-ui-sm font-medium text-foreground-subtle';
    el.textContent = text;
    return el;
  }

  /** 区头右侧按钮：打开浮动面板并直跳市场 tab；全局缺失时降级快捷键提示。 */
  function makeAddPluginButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = OFFICIAL_PRIMARY_BTN;
    btn.textContent = '+ 添加插件';
    btn.addEventListener('click', () => {
      if (typeof window.ZMod?.openManager === 'function') {
        window.ZMod.openManager('market');
      } else {
        ui.showToast('按 Ctrl+Shift+M 打开面板', 'warn');
      }
    });
    return btn;
  }

  /** 未启用分组：虚线容器 + 顶部提示行 + 行卡；同时是拖放安装的 dropzone。 */
  function buildDisabledDropzone(disabledDefs) {
    const zone = document.createElement('div');
    zone.className = 'flex flex-col gap-2 rounded-xl border border-dashed border-border p-2.5';
    zone.appendChild(groupLabel(`未启用 (${disabledDefs.length}) · 拖入即装`));
    const hint = document.createElement('div');
    hint.className = 'text-ui-xs text-foreground-subtle text-center';
    const HINT_TEXT = '拖入 .zip 或插件文件夹（可多选）,松手自动安装 · 新插件默认未启用,确认后再开启';
    hint.textContent = HINT_TEXT;
    zone.appendChild(hint);

    if (disabledDefs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'py-3 text-center text-ui-sm text-foreground-subtle/70';
      empty.textContent = '暂无未启用插件';
      zone.appendChild(empty);
    }
    for (const def of disabledDefs) {
      zone.appendChild(installedPluginRow(def));
      if (confirmRemoveId === def.id) zone.appendChild(removeConfirmBar(def));
      if (settingsOpenId === def.id) zone.appendChild(pluginSettingsForm(def));
    }

    // 拖放接线：高亮用主题 token 内联样式（追加的 Tailwind 类未必在宿主 bundle 生成过）；
    // dragenter/dragleave 在子元素间跳动，用进入计数消除高亮闪烁。
    const HIGHLIGHT_BORDER = 'var(--color-primary, #3b82f6)';
    const HIGHLIGHT_BG = 'color-mix(in srgb, var(--color-primary, #3b82f6) 6%, transparent)';
    let depth = 0;
    const highlight = () => {
      zone.style.borderColor = HIGHLIGHT_BORDER;
      zone.style.background = HIGHLIGHT_BG;
    };
    const unhighlight = () => {
      zone.style.borderColor = '';
      zone.style.background = '';
    };
    // busy 传 true 用默认文案、传字符串显示进度（批量时逐个更新）、传 false 恢复
    const setBusy = (busy) => {
      if (!hint.isConnected) return;
      hint.textContent = busy === false ? HINT_TEXT : typeof busy === 'string' ? busy : '校验安装中…';
    };

    zone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth += 1;
      highlight();
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) unhighlight();
    });
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      unhighlight();
      const dt = e.dataTransfer;
      // DataTransferItem 在事件循环让出后失效：先同步分拣全部拖入项，再逐个异步安装
      const { tasks, skippedNames } = collectDropTasks(dt?.items);
      if (tasks.length === 0) {
        if (skippedNames.length > 0) ui.showToast('仅支持 .zip 或插件文件夹', 'warn');
        return;
      }
      // 串行逐个安装（并行会同时写 plugins 目录并与目录监视竞争）；单项失败不阻断后续
      const results = [];
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        setBusy(`校验安装中…（第 ${i + 1}/${tasks.length} 个）`);
        try {
          let res;
          if (task.kind === 'zip') {
            const zipBase64 = arrayBufferToBase64(await task.file.arrayBuffer());
            res = await api.invoke('plugin.installUpload', { kind: 'zip', name: task.name, zipBase64 });
          } else {
            const files = await collectFilesFromEntry(task.entry);
            res = await api.invoke('plugin.installUpload', { kind: 'files', name: task.name, files });
          }
          results.push(res && res.ok
            ? { name: task.name, ok: true }
            : { name: task.name, ok: false, error: (res && res.error) || '安装失败' });
        } catch (err) {
          results.push({
            name: task.name,
            ok: false,
            error: err?.code === 'DROP_TOO_LARGE' ? '插件包过大' : (err?.message || String(err))
          });
        }
      }
      // 汇总反馈：单个沿用单装语义；多个合并一条，失败项与被跳过项点名
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      let msg;
      let level;
      if (results.length === 1) {
        msg = results[0].ok ? '已安装到未启用区(默认未启用)' : results[0].error;
        level = results[0].ok ? 'success' : 'error';
      } else if (failed.length === 0) {
        msg = `已安装 ${okCount} 个插件（默认未启用）`;
        level = 'success';
      } else {
        msg = `已安装 ${okCount} 个，失败 ${failed.length} 个：${failed.map((r) => `${r.name}(${r.error})`).join('、')}`;
        level = 'error';
      }
      if (skippedNames.length > 0) msg += `；已跳过：${skippedNames.join('、')}`;
      ui.showToast(msg, level);
      setBusy(false);
      renderContent(); // 成功时列表刷新由 plugin-changed 广播驱动，这里的重绘只是兜底
    });
    return zone;
  }

  function installedPluginRow(def) {
    const isBuiltin = def._installed?.source === 'builtin';
    const row = document.createElement('div');
    row.className = 'flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3';
    row.innerHTML = `
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-ui-base font-medium text-foreground">${esc(def.name || def.id)}</span>
          <span class="shrink-0 text-ui-xs text-foreground-subtle">v${esc(def.version || '1.0.0')}</span>
          ${isBuiltin ? '<span class="shrink-0 rounded-sm bg-tag px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">随基座</span>' : ''}
        </div>
        ${def.description ? `<div class="mt-0.5 truncate text-ui-sm text-foreground-subtle">${esc(def.description)}</div>` : ''}
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'flex shrink-0 items-center gap-1';
    if (def.settings && Object.keys(def.settings).length > 0) {
      actions.appendChild(textButton('设置', 'gear', () => {
        settingsOpenId = settingsOpenId === def.id ? null : def.id;
        renderContent();
      }));
    }
    const removeBtn = textButton('移除', 'trash', () => {
      confirmRemoveId = confirmRemoveId === def.id ? null : def.id;
      settingsOpenId = null;
      renderContent();
    });
    // 危险色：destructive 是官方主题 token（Switch 轨道类里已引用），带兜底色
    removeBtn.classList.remove('text-foreground');
    removeBtn.style.color = 'var(--color-destructive, #ef4444)';
    actions.appendChild(removeBtn);
    actions.appendChild(makeSwitch(registry.isActive(def.id), async (checked) => {
      if (checked) await registry.enable(def.id, { persist: true });
      else await registry.disable(def.id, { persist: true });
      renderContent();
    }, (m, l) => ui.showToast(m, l)));
    row.appendChild(actions);
    return row;
  }

  /** 移除确认条（面板 zmod-mgr-confirm 的官方风格版）：行下内联展开，不走 window.confirm。 */
  function removeConfirmBar(def) {
    const isBuiltin = def._installed?.source === 'builtin';
    const bar = document.createElement('div');
    bar.className = 'flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5';
    const text = document.createElement('span');
    text.className = 'min-w-0 flex-1 text-ui-sm text-foreground-subtle';
    text.textContent =
      `确认移除 ${def.name || def.id}？配置将保留，重新安装后默认启用` +
      (isBuiltin ? '（随基座发布，重跑安装器会重新部署）' : '');
    bar.appendChild(text);
    bar.appendChild(textButton('取消', null, () => {
      confirmRemoveId = null;
      renderContent();
    }));
    const ok = primaryButton('确认移除', async () => {
      try {
        const res = await api.invoke('plugin.remove', { id: def.id });
        confirmRemoveId = null;
        settingsOpenId = null;
        if (res && res.ok) ui.showToast('已移除', 'success');
        else ui.showToast((res && res.error) || '移除失败', 'error');
      } catch (err) {
        confirmRemoveId = null;
        ui.showToast(`移除失败：${err?.message || err}`, 'error');
      }
      renderContent();
    });
    ok.style.background = 'var(--color-destructive, #dc2626)';
    bar.appendChild(ok);
    return bar;
  }

  /** 内联设置表单：与 ManagerPanel._renderSettings 同款 renderSettingsForm 调用范式。 */
  function pluginSettingsForm(def) {
    const id = def.id;
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3';
    wrap.appendChild(
      ui.renderSettingsForm(def, registry.getActiveSettings(id), async (key, value) => {
        const active = registry._active.get(id);
        if (active) {
          // route through the registry ctx so plugin onChange listeners fire
          await active.ctx.settings.set(key, value);
        } else {
          await api.invoke('config.setPluginSetting', { pluginId: id, key, value });
        }
      }, async (actionKey) => {
        const action = def.actions?.[actionKey];
        const active = registry._active.get(id);
        if (!action) return;
        if (!active) {
          ui.showToast('请先启用该插件再执行操作', 'warn');
          return;
        }
        try {
          const res = await action.run(active.ctx);
          if (res && res.message) ui.showToast(res.message, res.ok === false ? 'warn' : 'success');
          else if (res?.ok) ui.showToast('完成', 'success');
        } catch (err) {
          ui.showToast(`执行失败：${err?.message || err}`, 'error');
        }
      })
    );
    return wrap;
  }

  function iconButton(icon, label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.className =
      'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground';
    btn.innerHTML = iconHtml(icon, 'size-4');
    btn.addEventListener('click', onClick);
    return btn;
  }

  const OFFICIAL_PRIMARY_BTN =
    'group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding whitespace-nowrap ' +
    'transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-50 ' +
    'bg-primary text-primary-foreground hover:bg-primary/80 h-7 gap-1 px-2 text-ui-base rounded-lg';

  /* ---------------- datasources page ---------------- */
  async function renderDatasourcesPage(root) {
    if (detail?.kind === 'ds-edit') {
      renderDatasourceEditor(root, detail);
      return;
    }
    await datasources.load();

    const instances = datasources.getInstances();
    const providers = datasources.getProviders();

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between';
    header.innerHTML = `<h3 class="text-ui-sm font-medium text-foreground-subtle">数据源 (${instances.length})</h3>`;
    if (providers.length > 0) {
      header.appendChild(textButton('添加数据源', 'plus', () => {
        detail = { kind: 'ds-edit', editing: null, title: '添加数据源' };
        renderContent();
      }));
    }
    root.appendChild(header);

    if (providers.length === 0) {
      const warn = document.createElement('div');
      warn.className = 'rounded-xl border border-dashed border-border px-4 py-6 text-center text-ui-sm text-foreground-subtle';
      warn.textContent = '尚未加载任何数据源类型（Provider）。重启客户端或检查渲染内核控制台输出。';
      root.appendChild(warn);
      return;
    }
    if (instances.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rounded-xl border border-dashed border-border px-4 py-6 text-center text-ui-sm text-foreground-subtle';
      empty.textContent = '还没有数据源。点击右上角「添加数据源」，或接入下方检测到的账号。';
      root.appendChild(empty);
      await renderAutodetectSection(root, providers);
      return;
    }

    for (const inst of instances) {
      root.appendChild(await datasourceCard(inst));
    }

    await renderAutodetectSection(root, providers);
  }

  /**
   * Auto-detected sources: fully-derivable ones offer one-click adoption,
   * known-but-unfetchable ones show as dashed placeholder cards.
   */
  async function renderAutodetectSection(root, providers) {
    let detect;
    try {
      detect = await api.invoke('datasource.autodetect', {});
    } catch {
      return; // main runtime too old / RPC unavailable — stay silent
    }
    const proposals = (detect?.proposals || []).filter((p) => p.status !== 'configured');
    if (!proposals.length) return;

    const labelByType = new Map(providers.map((p) => [p.type, p.label]));
    const title = document.createElement('div');
    title.className = 'mt-4 flex items-center justify-between';
    title.innerHTML = '<h3 class="text-ui-sm font-medium text-foreground-subtle">检测到的账号</h3>';
    title.appendChild(textButton('重新检测', 'refresh', () => renderContent()));
    root.appendChild(title);

    for (const p of proposals) {
      const card = document.createElement('div');
      card.className =
        p.status === 'ready'
          ? 'mt-2 flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3'
          : 'mt-2 flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3';
      const info = document.createElement('div');
      info.className = 'min-w-0 flex-1';
      info.innerHTML = `
        <div class="truncate text-ui-base font-medium text-foreground">${esc(p.name)}</div>
        <div class="text-ui-sm text-foreground-subtle">${esc(labelByType.get(p.type) || p.type)}</div>
        <div class="text-ui-xs text-foreground-subtle/80">${esc(p.reason || '')}</div>`;
      card.appendChild(info);
      if (p.status === 'ready') {
        card.appendChild(
          primaryButton('一键接入', async () => {
            try {
              // secret-typed fields ride along in settings; the registry
              // splits them into the vault on save
              await datasources.saveInstance({
                type: p.type,
                name: p.name,
                settings: { ...(p.settings || {}), ...(p.secrets || {}) }
              });
              ui.showToast(`已接入「${p.name}」`, 'success');
              renderContent();
            } catch (err) {
              ui.showToast(`接入失败：${err?.message || err}`, 'error');
            }
          })
        );
      } else {
        // Placeholder: reason + credential guide link + a single editor
        // entry with the provider type preselected — the editor's preset
        // defaults keep it to "name + the keys this provider needs".
        if (p.guide?.url) {
          const link = document.createElement('a');
          link.href = p.guide.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'text-ui-xs text-primary hover:underline';
          link.textContent = p.guide.text || '获取凭据';
          link.addEventListener('click', (ev) => {
            ev.preventDefault();
            api.invoke('system.openExternal', { url: p.guide.url }).catch(() => {});
          });
          info.appendChild(link);
        }

        const main = document.createElement('div');
        main.className = 'flex items-center gap-2';
        main.appendChild(
          textButton('去配置', 'plus', () => {
            detail = { kind: 'ds-edit', editing: null, title: `配置 ${p.name}`, presetType: p.type };
            renderContent();
          })
        );
        card.appendChild(main);
      }
      root.appendChild(card);
    }
  }

  async function datasourceCard(inst) {
    const provider = datasources.getProvider(inst.type);
    const card = document.createElement('div');
    card.className = 'flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3';
    card.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="truncate text-ui-base font-medium text-foreground">${esc(inst.name)}</div>
          <div class="text-ui-sm text-foreground-subtle">${esc(provider?.label || inst.type)}</div>
        </div>
      </div>`;
    const toolbar = document.createElement('div');
    toolbar.className = 'flex items-center gap-1';
    // firstElementChild, not firstChild: the innerHTML template starts with a
    // newline, so firstChild would be a text node (no appendChild).
    card.firstElementChild.appendChild(toolbar);
    toolbar.appendChild(iconButton('refresh', '刷新状态', async () => {
      await refreshStatusInto(inst.id, card, { force: true });
    }));
    toolbar.appendChild(iconButton('pencil', '编辑', () => {
      detail = { kind: 'ds-edit', editing: inst.id, title: `编辑 ${inst.name}` };
      renderContent();
    }));
    toolbar.appendChild(iconButton('trash', '删除', async () => {
      await datasources.deleteInstance(inst.id);
      renderContent();
    }));
    const statusBox = document.createElement('div');
    statusBox.className = 'flex flex-col gap-1 text-ui-sm';
    statusBox.setAttribute('data-zmod-ds-status', inst.id);
    statusBox.innerHTML = '<div class="text-foreground-subtle">未刷新</div>';
    card.appendChild(statusBox);
    // hydrate from cache (no forced network on render)
    refreshStatusInto(inst.id, card, { force: false });
    return card;
  }

  async function refreshStatusInto(id, card, { force }) {
    const box = card.querySelector(`[data-zmod-ds-status="${id}"]`);
    if (!box) return;
    const status = await datasources.getStatus(id, { force });
    if (!status) return;
    if (!status.ok) {
      box.innerHTML = `<div class="text-ui-sm text-foreground-subtle">查询失败：${esc(status.message || '未知错误')}</div>`;
      return;
    }
    const rows = (status.rows || []).map(
      (r) =>
        `<div class="flex items-baseline justify-between gap-4"><span class="text-foreground-subtle">${esc(r.label)}</span><span class="font-medium text-foreground">${esc(r.value)}${r.hint ? ` <span class="text-ui-xs font-normal text-foreground-subtle">${esc(r.hint)}</span>` : ''}</span></div>`
    );
    if (status.balance) {
      rows.unshift(
        `<div class="flex items-baseline justify-between gap-4"><span class="text-foreground-subtle">余额</span><span class="text-ui-base font-semibold text-foreground">${esc(status.balance)}${status.currency ? ` ${esc(status.currency)}` : ''}</span></div>`
      );
    }
    const time = new Date(status.ts).toLocaleTimeString();
    box.innerHTML =
      (rows.length ? rows.join('') : `<div class="text-foreground-subtle">${esc(status.message || '无数据')}</div>`) +
      `<div class="text-ui-xs text-foreground-subtle/70">更新于 ${esc(time)}</div>`;
  }

  async function renderDatasourceEditor(root) {
    const providers = datasources.getProviders();
    const editing = detail.editing ? datasources.getInstance(detail.editing) : null;

    const card = document.createElement('div');
    card.className = 'flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4';
    root.appendChild(card);

    if (!editing) {
      const typeRow = document.createElement('div');
      typeRow.className = 'flex flex-col gap-1.5';
      typeRow.innerHTML = `<label class="text-ui-base font-medium text-foreground">类型</label>`;
      const select = document.createElement('select');
      select.className = FORM_INPUT_CLS + ' cursor-pointer';
      for (const p of providers) {
        const opt = document.createElement('option');
        opt.value = p.type;
        opt.textContent = p.label;
        select.appendChild(opt);
      }
      typeRow.appendChild(select);
      card.appendChild(typeRow);
      if (detail?.presetType && providers.some((p) => p.type === detail.presetType)) {
        select.value = detail.presetType;
      }
      select.addEventListener('change', () => buildProviderForm(card, select.value, null));
      buildProviderForm(card, select.value || providers[0]?.type, null);
    } else {
      buildProviderForm(card, editing.type, editing);
    }

    function buildProviderForm(container, type, instance) {
      container.querySelectorAll('[data-zmod-ds-form]').forEach((n) => n.remove());
      const provider = datasources.getProvider(type);
      if (!provider) return;
      const pseudo = { id: 'ds', name: instance?.name || '', settings: provider.settings };

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = '显示名称（如：我的百炼账号）';
      nameInput.value = instance?.name || '';
      nameInput.className = FORM_INPUT_CLS + ' mb-2';
      nameInput.setAttribute('data-zmod-ds-form', '1');
      container.appendChild(nameInput);

      const values = { ...(instance?.settings || {}) };
      const formWrap = document.createElement('div');
      formWrap.setAttribute('data-zmod-ds-form', '1');
      container.appendChild(formWrap);
      formWrap.appendChild(
        ui.renderSettingsForm(pseudo, values, (key, value) => {
          values[key] = value;
        })
      );

      const actions = document.createElement('div');
      actions.className = 'mt-2 flex items-center gap-2';
      actions.setAttribute('data-zmod-ds-form', '1');
      const testBtn = primaryButton('测试连接', async () => {
        const res = await datasources.testInstance({ id: instance?.id, type, settings: values, name: nameInput.value });
        ui.showToast(res.ok ? res.message || '连接成功' : `失败：${res.message || '未知错误'}`, res.ok ? 'success' : 'warn');
      });
      const saveBtn = primaryButton('保存', async () => {
        if (!nameInput.value.trim()) {
          ui.showToast('请填写显示名称', 'warn');
          return;
        }
        try {
          await datasources.saveInstance({ id: instance?.id, type, name: nameInput.value.trim(), settings: values });
          ui.showToast('已保存', 'success');
          detail = null;
          renderContent();
        } catch (err) {
          ui.showToast(`保存失败：${err?.message || err}`, 'error');
        }
      });
      actions.appendChild(testBtn);
      actions.appendChild(saveBtn);
      container.appendChild(actions);
    }
  }

  function textButton(label, icon, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-ui-base text-foreground transition-colors hover:bg-surface-hover';
    // icon 为空时渲染纯文字（如确认条里的「取消」）
    btn.innerHTML = icon ? `${iconHtml(icon, 'size-3.5')}<span>${esc(label)}</span>` : `<span>${esc(label)}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function primaryButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = OFFICIAL_PRIMARY_BTN;
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await onClick(btn);
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }

  /* ------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------ */
  function start() {
    // Injected rules, all self-cleaning via :has() so nothing lingers when the
    // condition (our overlay / our crumb) disappears:
    //  1. overlay mode paints over the official content column — keep the
    //     official content invisible underneath instead of relying on stacking.
    //  2. overlay mode leaves the host's own section selected in React state,
    //     so neutralise its highlight: official active styling is nothing but
    //     the button background (label and icon keep text-foreground either
    //     way), which keeps exactly one item reading as selected.
    //  3. native mode drilled into a sub-page: the host shows a page title for
    //     single-level sections, official drilled-in views show a breadcrumb
    //     instead — match the host's own rule.
    if (!document.getElementById('zmod-settings-overlay-style')) {
      const st = document.createElement('style');
      st.id = 'zmod-settings-overlay-style';
      st.textContent = [
        '[data-settings-panel-frame]:has(> [data-zmod-settings-overlay]) main{visibility:hidden !important}',
        '[data-active-section]:has([data-zmod-settings-overlay]) nav [data-settings-section-nav][aria-current="page"]{background-color:transparent !important}',
        '[data-settings-panel-frame]:has([data-zmod-native-crumb]) main h2{display:none !important}'
      ].join('\n');
      document.head.appendChild(st);
    }
    observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  function destroy() {
    observer?.disconnect();
    observer = null;
    nativeObserver?.disconnect();
    nativeObserver = null;
    // Leaving our sections registered without the code that fills them would
    // show an empty ZMod section, so take them back out.
    try {
      nativeReg?.undo();
    } catch {}
    nativeReg = null;
    teardownNativeDom();
    detachNav();
  }

  return {
    start,
    destroy,
    /**
     * 安装/移除/更新广播后的存活刷新：仅当设置页打开且正停在插件页时重绘，
     * 未打开时不做无谓渲染（与 zmod:config-changed 的处理同判据）。
     */
    refresh() {
      if (!dialogOpen || activeItem !== 'plugins' || detail) return;
      if (mode !== 'native' && (!overlay || !overlay.isConnected)) return;
      try { renderContent(); } catch {}
    },
    /** Plugins may add overview sections on the 扩展插件 page. */
    contribute(def) {
      if (!def?.id || typeof def.render !== 'function') return false;
      contributions.set(def.id, def);
      if (activeItem === 'plugins') renderContent();
      return true;
    },
    uncontribute(id) {
      contributions.delete(id);
      if (activeItem === 'plugins') renderContent();
    },
    open() {
      const first = NATIVE_SECTIONS[0];
      if (mode === 'native') {
        document.querySelector(`nav [data-settings-section-nav="${first.id}"]`)?.click();
        return;
      }
      activate('plugins');
    }
  };
}

const FORM_INPUT_CLS =
  'h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-ui-base text-foreground outline-none transition-colors placeholder:text-foreground-subtle/60 focus-visible:ring-1 focus-visible:ring-input-border-focused';