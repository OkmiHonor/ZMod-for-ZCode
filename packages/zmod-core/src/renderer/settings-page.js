/**
 * ZMod → official Settings page integration (native look).
 *
 * Adds a "ZMod" group to the official settings sidebar and renders content
 * as an overlay aligned to the official content column. Every class name
 * below is the host's own Tailwind token vocabulary (extracted from the
 * official settings components), so the result is indistinguishable from
 * first-party UI and follows theme changes for free.
 *
 * Hard rules learned from the v1 era:
 *  - NEVER mutate the official React-managed DOM (no insertBefore into
 *    React-owned containers, no hiding official nodes) — the reconciler
 *    re-renders forever. We only append our own subtree and overlay.
 *  - Nav discovery is locale-independent: official nav items carry
 *    [data-settings-section-nav]; content column is inside
 *    [data-settings-panel-frame].
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
  left:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg>'
};

function iconHtml(name, cls = 'size-4') {
  return ICONS[name].replace('<svg ', `<svg class="${cls}" `);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
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

export function createSettingsPageIntegration({ api, events, registry, datasources, ui }) {
  let observer = null;
  let navEl = null;
  let groupEl = null;
  let navClickHandler = null;
  let overlay = null;
  let overlayHostCol = null;
  let activeItem = null;
  let detail = null; // { kind: 'plugin-settings' } etc. per active item
  let realignRaf = 0;
  const contributions = new Map(); // id -> { id, title, render(el) }

  /* ------------------------------------------------------------ *
   * Sidebar group injection
   * ------------------------------------------------------------ */
  function scan() {
    const nav = document.querySelector('nav [data-settings-section-nav]')?.closest('nav');
    if (nav && !navEl) attachNav(nav);
    if (!nav && navEl) detachNav();
    if (navEl && activeItem) realign();
  }

  function attachNav(nav) {
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
    console.log('[ZMod:SettingsPage] ZMod group injected into official settings sidebar');
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
    activeItem = null;
    detail = null;
  }

  /* ------------------------------------------------------------ *
   * Content overlay (aligned to official content column)
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

  function contentColumn() {
    const frame = document.querySelector('[data-settings-panel-frame]');
    if (!frame) return null;
    const main = frame.querySelector('main');
    const col = main?.parentElement;
    return col && col !== frame ? col : null;
  }

  function ensureOverlay() {
    const col = contentColumn();
    if (!col) return;
    overlayHostCol = col;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('data-zmod-settings-overlay', 'true');
      overlay.style.cssText = 'position:fixed;z-index:40;display:flex;flex-direction:column;';
      overlay.className = 'bg-background';
      document.body.appendChild(overlay);
    }
    realign();
  }

  function realign() {
    if (!overlay || !overlayHostCol || !overlayHostCol.isConnected) return;
    if (realignRaf) return;
    realignRaf = requestAnimationFrame(() => {
      realignRaf = 0;
      if (!overlay || !overlayHostCol?.isConnected) return;
      const r = overlayHostCol.getBoundingClientRect();
      overlay.style.left = `${r.left}px`;
      overlay.style.top = `${r.top}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
    });
  }

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
    overlayHostCol = null;
    if (realignRaf) {
      cancelAnimationFrame(realignRaf);
      realignRaf = 0;
    }
  }

  /* ------------------------------------------------------------ *
   * Content rendering
   * ------------------------------------------------------------ */
  function renderContent() {
    if (!overlay || !activeItem) return;
    overlay.innerHTML = '';
    const item = NAV_ITEMS.find((i) => i.id === activeItem);

    // Breadcrumb row — official height/typography.
    const crumb = document.createElement('div');
    crumb.className = 'flex h-12 shrink-0 items-center gap-1.5 px-6 text-ui-sm text-foreground-subtle';
    crumb.innerHTML =
      `<span>设置</span><span class="text-foreground-subtle/60">/</span>` +
      `<span class="${detail ? 'cursor-pointer hover:text-foreground' : 'text-foreground'}" data-zmod-crumb-back="1">ZMod · ${esc(item.label)}</span>` +
      (detail ? `<span class="text-foreground-subtle/60">/</span><span class="text-foreground">${esc(detail.title || '')}</span>` : '');
    crumb.querySelector('[data-zmod-crumb-back]')?.addEventListener('click', () => {
      detail = null;
      renderContent();
    });
    overlay.appendChild(crumb);

    const scroll = document.createElement('div');
    scroll.className = 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-8';
    overlay.appendChild(scroll);

    if (activeItem === 'plugins') {
      if (detail?.kind === 'plugin-settings') renderPluginDetail(scroll);
      else renderPluginsPage(scroll);
    } else {
      renderDatasourcesPage(scroll);
    }
  }

  /* ---------------- extensions page ---------------- */
  function renderPluginsPage(root) {
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

    const listTitle = document.createElement('h3');
    listTitle.className = 'text-ui-sm font-medium text-foreground-subtle';
    listTitle.textContent = '已安装的扩展';
    root.appendChild(listTitle);

    const defs = registry.getAll();
    if (defs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rounded-xl border border-dashed border-border px-4 py-6 text-center text-ui-sm text-foreground-subtle';
      empty.textContent = '未发现任何插件。将插件放入 %APPDATA%/ZMod/plugins 后重启客户端。';
      root.appendChild(empty);
      return;
    }

    for (const def of defs) {
      root.appendChild(pluginRow(def));
    }
  }

  function pluginRow(def) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3';
    row.innerHTML = `
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-ui-base font-medium text-foreground">${esc(def.name || def.id)}</span>
          <span class="shrink-0 rounded-sm bg-tag px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">v${esc(def.version || '1.0.0')}</span>
          ${registry.isActive(def.id) ? '' : '<span class="shrink-0 text-ui-xs text-foreground-subtle">已停用</span>'}
        </div>
        ${def.description ? `<div class="mt-0.5 truncate text-ui-sm text-foreground-subtle">${esc(def.description)}</div>` : ''}
      </div>`;

    const hasSettings = def.settings && Object.keys(def.settings).length > 0;
    const hasActions = def.actions && Object.keys(def.actions).length > 0;
    if (hasSettings || hasActions) {
      row.appendChild(iconButton('gear', `打开 ${def.name || def.id} 设置`, async () => {
        detail = { kind: 'plugin-settings', id: def.id, title: `${def.name || def.id} · 设置` };
        renderContent();
      }));
    }
    row.appendChild(makeSwitch(registry.isActive(def.id), async (checked) => {
      if (checked) await registry.enable(def.id, { persist: true });
      else await registry.disable(def.id, { persist: true });
      renderContent();
    }));
    return row;
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

  function makeSwitch(checked, onChange) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', String(Boolean(checked)));
    btn.className =
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors ' +
      (checked ? 'border-transparent bg-foreground' : 'border-border bg-transparent');
    const knob = document.createElement('span');
    knob.className =
      'pointer-events-none block size-4 rounded-full transition-transform ' +
      (checked ? 'translate-x-4 bg-background' : 'translate-x-0 bg-foreground-subtle');
    btn.appendChild(knob);
    btn.addEventListener('click', async () => {
      const next = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(next));
      btn.className =
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors ' +
        (next ? 'border-transparent bg-foreground' : 'border-border bg-transparent');
      knob.className =
        'pointer-events-none block size-4 rounded-full transition-transform ' +
        (next ? 'translate-x-4 bg-background' : 'translate-x-0 bg-foreground-subtle');
      try {
        await onChange(next);
      } catch (err) {
        ui.showToast(`操作失败：${err?.message || err}`, 'error');
      }
    });
    return btn;
  }

  function renderPluginDetail(root) {
    const def = registry.getAll().find((d) => d.id === detail.id);
    if (!def) {
      detail = null;
      renderContent();
      return;
    }
    const card = document.createElement('div');
    card.className = 'flex flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-4';
    root.appendChild(card);
    card.appendChild(
      ui.renderSettingsForm(def, registry.getActiveSettings(def.id), async (key, value) => {
        const active = registry._active.get(def.id);
        if (active) await active.ctx.settings.set(key, value);
        else await api.invoke('config.setPluginSetting', { pluginId: def.id, key, value });
      }, async (actionKey) => {
        const action = def.actions?.[actionKey];
        const active = registry._active.get(def.id);
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
  }

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
      warn.textContent = '尚未安装任何数据源类型（Provider）。安装 official-providers 等插件后可在此添加。';
      root.appendChild(warn);
      return;
    }
    if (instances.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rounded-xl border border-dashed border-border px-4 py-6 text-center text-ui-sm text-foreground-subtle';
      empty.textContent = '还没有数据源。点击右上角「添加数据源」接入第一个账号 / 网关。';
      root.appendChild(empty);
      return;
    }

    for (const inst of instances) {
      root.appendChild(await datasourceCard(inst));
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
    card.firstChild.appendChild(toolbar);
    toolbar.appendChild(iconButton('refresh', '刷新状态', async (e) => {
      const btn = e?.currentTarget || e?.target;
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

  async function renderDatasourceEditor(root, d) {
    const providers = datasources.getProviders();
    const editing = d.editing ? datasources.getInstance(d.editing) : null;

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
      select.addEventListener('change', () => buildProviderForm(card, select.value, null));
      buildProviderForm(card, providers[0]?.type, null);
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
      const testBtn = primaryButton('测试连接', async (btn) => {
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
    btn.innerHTML = `${iconHtml(icon, 'size-3.5')}<span>${esc(label)}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function primaryButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'inline-flex h-8 min-w-24 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-foreground px-3 text-ui-base font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50';
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
    observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  function destroy() {
    observer?.disconnect();
    observer = null;
    detachNav();
  }

  return {
    start,
    destroy,
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
      activate('plugins');
    }
  };
}

const FORM_INPUT_CLS =
  'h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-ui-base text-foreground outline-none transition-colors placeholder:text-foreground-subtle/60 focus-visible:ring-1 focus-visible:ring-input-border-focused';
