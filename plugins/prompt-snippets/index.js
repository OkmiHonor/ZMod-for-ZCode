import { definePlugin } from '@zmod/sdk';

const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

function placeholdersOf(content) {
  const out = [];
  const re = new RegExp(VAR_RE.source, 'g');
  let m;
  while ((m = re.exec(String(content || ''))) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function fillPlaceholders(content, values) {
  return String(content || '').replace(VAR_RE, (whole, name) => {
    const v = values[name];
    return v === undefined || v === '' ? whole : v;
  });
}

const PANEL_CSS = `
  .zps-fab { position:fixed; z-index:2147482900; display:none; align-items:center; gap:5px; padding:3px 10px;
    background:rgba(13,17,23,.72); border:1px solid #30363d; border-radius:999px; color:#8b949e; font-size:12px;
    cursor:grab; pointer-events:auto; user-select:none; backdrop-filter:blur(6px);
    font-family:inherit; line-height:18px; touch-action:none; }
  .zps-fab:hover { color:#e6edf3; background:#161b22; border-color:#3d444d; }
  .zps-fab.drag { opacity:.85; cursor:grabbing; }
  .zps-fab svg { width:13px; height:13px; fill:currentColor; flex-shrink:0; }
  .zps-panel { position:fixed; right:24px; bottom:148px; z-index:2147482900; width:380px; max-height:460px;
    display:flex; flex-direction:column; background:rgba(30,32,38,.97); color:#e8e8ea; border-radius:12px;
    border:1px solid rgba(255,255,255,.12); box-shadow:0 18px 48px rgba(0,0,0,.45); backdrop-filter:blur(12px);
    font-size:13px; pointer-events:auto; overflow:hidden; }
  .zps-head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.08); }
  .zps-search { flex:1; padding:6px 10px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12);
    border-radius:6px; color:#eee; font-size:13px; outline:none; }
  .zps-add { cursor:pointer; background:none; border:1px solid rgba(255,255,255,.18); color:#cbd5e1; border-radius:6px; padding:4px 9px; }
  .zps-add:hover { border-color:#3b82f6; color:#fff; }
  .zps-list { overflow-y:auto; flex:1; }
  .zps-item { padding:9px 12px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.05); display:flex; justify-content:space-between; gap:8px; align-items:center; }
  .zps-item:hover { background:rgba(255,255,255,.06); }
  .zps-item-name { font-weight:500; }
  .zps-item-tags { color:#7d8590; font-size:11px; margin-top:2px; }
  .zps-item-vars { color:#fbbf24; font-size:11px; margin-left:6px; }
  .zps-del { cursor:pointer; background:none; border:none; color:#6b7280; font-size:13px; padding:2px 6px; border-radius:4px; }
  .zps-del:hover { color:#f87171; background:rgba(255,255,255,.06); }
  .zps-edit { display:flex; flex-direction:column; gap:8px; padding:12px; }
  .zps-edit input, .zps-edit textarea { padding:7px 10px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14);
    border-radius:6px; color:#eee; font-size:13px; outline:none; font-family:inherit; }
  .zps-edit textarea { min-height:90px; resize:vertical; }
  .zps-btnrow { display:flex; gap:8px; justify-content:flex-end; }
  .zps-btn { cursor:pointer; border:none; border-radius:6px; padding:6px 14px; font-size:13px; }
  .zps-primary { background:#3b82f6; color:#fff; }
  .zps-ghost { background:rgba(255,255,255,.08); color:#cbd5e1; }
  .zps-empty { color:#7d8590; text-align:center; padding:22px 0; }
`;

export default definePlugin({
  id: 'prompt-snippets',
  name: 'Prompt 片段库',
  description: '常驻悬浮球片段库：搜索、一键插入、{{变量}} 填充、Ctrl+/ 开关面板',
  version: '1.1.0-beta',
  author: 'ZMod Team',

  settings: {
    hotkey: {
      type: 'text',
      title: '面板快捷键',
      description: '当前固定为 Ctrl+/（浏览器级捕获）',
      default: 'Ctrl+/'
    }
  },

  async start(ctx) {
    const { settings, ui, cleanup } = ctx;

    let snippets = settings.get('snippets', null);
    if (!Array.isArray(snippets)) {
      snippets = [
        { id: 's1', name: '重构优化', tags: 'code', content: '请按单一职责原则与高内聚低耦合重构以下模块：\n{{代码}}', useCount: 0 },
        { id: 's2', name: '生成单元测试', tags: 'test', content: '请为以下函数编写详尽的单测用例（覆盖边界与异常）：\n{{函数}}', useCount: 0 },
        { id: 's3', name: '排查问题', tags: 'debug', content: '以下是现象与线索，请给出根因假设与验证步骤：\n{{现象}}', useCount: 0 }
      ];
      settings.set('snippets', snippets);
    }
    const persist = () => settings.set('snippets', snippets);

    ui.injectStyle('prompt-snippets-css', PANEL_CSS);

    const fab = document.createElement('button');
    fab.className = 'zps-fab';
    fab.title = 'Prompt 片段库 (Ctrl+/)';
    // v1 同款外观：书签图标 + "片段"药丸（样式与锚定行为 1:1 移植自 v1 prompt-snippets v1.4）
    fab.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h7A1.5 1.5 0 0 1 13 2.5v11.75a.75.75 0 0 1-1.19.61L8 11.72l-3.81 3.14A.75.75 0 0 1 3 14.25Z"/></svg><span>片段</span>';
    document.body.appendChild(fab);

    /* 标题栏（拖拽区）下缘：WCO 优先，app-region:drag 多采样探测兜底，最后常量 48。
       球进入拖拽区后指针事件被系统窗口拖拽吞掉=永久卡死，所以钳制不能失效。 */
    let tbCache = -1, tbAt = 0;
    const titlebarBottom = () => {
      const now = Date.now();
      if (tbCache >= 0 && now - tbAt < 2000) return tbCache;
      let v = 0;
      try {
        const wco = navigator.windowControlsOverlay;
        if (wco && typeof wco.getTitlebarAreaRect === 'function') {
          const r = wco.getTitlebarAreaRect();
          if (r && r.height > 0 && r.height < window.innerHeight) v = r.top + r.height;
        }
      } catch {}
      if (!v) {
        try {
          for (const fx of [0.5, 0.3, 0.7]) {
            const cx = Math.max(20, Math.floor(window.innerWidth * fx));
            for (let y = 4; y <= 72 && !v; y += 4) {
              let n = document.elementFromPoint(cx, y), hop = 0;
              while (n && n !== document.body && hop < 16) {
                if (getComputedStyle(n).webkitAppRegion === 'drag') {
                  const dr = n.getBoundingClientRect();
                  if (dr.top <= 2 && dr.width > window.innerWidth * 0.3) { v = dr.bottom; break; }
                  break;
                }
                n = n.parentElement; hop++;
              }
            }
            if (v) break;
          }
        } catch {}
      }
      if (!v) v = 48;
      tbCache = v; tbAt = now;
      return v;
    };

    /* 锚定：默认吸附输入框右上角上方 28px（v1 行为）；拖拽后自由定位，
       始终钳制在窗口内且不得进入标题栏拖拽区；无输入框（设置页等）整组隐藏 */
    let freePos = null; // {x,y} 非空 = 自由定位
    const repositionFab = () => {
      const c = findComposer();
      if (!c) { fab.style.display = 'none'; if (panel.style.display !== 'none') panel.style.display = 'none'; return; }
      fab.style.display = 'flex';
      const tb = titlebarBottom();
      if (freePos) {
        freePos.x = Math.min(Math.max(4, freePos.x), Math.max(4, window.innerWidth - fab.offsetWidth - 4));
        freePos.y = Math.min(Math.max(tb + 2, freePos.y), Math.max(tb + 2, window.innerHeight - fab.offsetHeight - 4));
        fab.style.left = freePos.x + 'px';
        fab.style.top = freePos.y + 'px';
        fab.style.right = 'auto';
        return;
      }
      const r = c.el.getBoundingClientRect();
      fab.style.top = Math.max(tb + 2, r.top - 28) + 'px';
      fab.style.right = Math.max(10, window.innerWidth - r.right) + 'px';
      fab.style.left = 'auto';
    };
    window.addEventListener('resize', repositionFab);
    const posTimer = setInterval(repositionFab, 400);
    cleanup(() => { window.removeEventListener('resize', repositionFab); clearInterval(posTimer); });

    /* 拖拽/点击判定（v1 同款）：位移 <4px = 点击展开，否则拖动；右键复位默认锚定 */
    let drag = null;
    fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = fab.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, l: r.left, t: r.top, moved: false };
      try { fab.setPointerCapture(e.pointerId); } catch {}
    });
    fab.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && dx * dx + dy * dy < 16) return;
      drag.moved = true;
      fab.classList.add('drag');
      const tb = titlebarBottom();
      freePos = {
        x: Math.min(Math.max(4, drag.l + dx), Math.max(4, window.innerWidth - fab.offsetWidth - 4)),
        y: Math.min(Math.max(tb + 2, drag.t + dy), Math.max(tb + 2, window.innerHeight - fab.offsetHeight - 4))
      };
      repositionFab();
    });
    fab.addEventListener('pointerup', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      fab.classList.remove('drag');
      if (!moved) toggle();
    });
    fab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      freePos = null;
      repositionFab();
    });

    const panel = document.createElement('div');
    panel.className = 'zps-panel';
    panel.style.display = 'none';
    document.body.appendChild(panel);

    let query = '';
    let editing = null; // snippet being edited
    let filling = null; // snippet with {{vars}} pending values

    const findComposer = () => {
      const editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"]');
      if (editor) return { el: editor, kind: 'lexical' };
      const ta = document.querySelector('textarea');
      if (ta) return { el: ta, kind: 'textarea' };
      return null;
    };

    const insertText = (content) => {
      const c = findComposer();
      if (!c) {
        ui.showToast('请先打开一个对话会话', 'warn');
        return false;
      }
      try {
        if (c.kind === 'textarea') {
          // React controlled textarea: use the native setter then re-emit input
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value'
          ).set;
          setter.call(c.el, c.el.value + content);
          c.el.dispatchEvent(new Event('input', { bubbles: true }));
          c.el.focus();
          c.el.setSelectionRange(c.el.value.length, c.el.value.length);
        } else {
          c.el.focus();
          document.execCommand('insertText', false, content);
        }
        return true;
      } catch (err) {
        console.error('[ZMod:Snippets] insert failed:', err);
        ui.showToast('插入失败', 'error');
        return false;
      }
    };

    const useSnippet = (snip) => {
      const vars = placeholdersOf(snip.content);
      if (vars.length > 0) {
        filling = { snip, values: {} };
        render();
        return;
      }
      if (insertText(snip.content)) {
        snip.useCount = (snip.useCount || 0) + 1;
        persist();
        ui.showToast('已插入片段', 'success');
        panel.style.display = 'none';
      }
    };

    const renderList = (container) => {
      const list = document.createElement('div');
      list.className = 'zps-list';
      const q = query.trim().toLowerCase();
      const filtered = snippets.filter(
        (s) =>
          !q ||
          (s.name || '').toLowerCase().includes(q) ||
          (s.tags || '').toLowerCase().includes(q) ||
          (s.content || '').toLowerCase().includes(q)
      );
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'zps-empty';
        empty.textContent = snippets.length === 0 ? '还没有片段，点右上角 + 新建' : '无匹配片段';
        list.appendChild(empty);
      }
      for (const snip of filtered) {
        const item = document.createElement('div');
        item.className = 'zps-item';
        const left = document.createElement('div');
        const nameEl = document.createElement('div');
        nameEl.className = 'zps-item-name';
        nameEl.textContent = snip.name || '(未命名)';
        if (placeholdersOf(snip.content).length > 0) {
          const v = document.createElement('span');
          v.className = 'zps-item-vars';
          v.textContent = '⚠ 有变量';
          nameEl.appendChild(v);
        }
        left.appendChild(nameEl);
        if (snip.tags) {
          const tags = document.createElement('div');
          tags.className = 'zps-item-tags';
          tags.textContent = snip.tags;
          left.appendChild(tags);
        }
        item.appendChild(left);
        const del = document.createElement('button');
        del.className = 'zps-del';
        del.title = '删除';
        del.textContent = '✕';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          snippets = snippets.filter((s) => s.id !== snip.id);
          persist();
          render();
        });
        item.appendChild(del);
        item.addEventListener('click', () => useSnippet(snip));
        list.appendChild(item);
      }
      container.appendChild(list);
    };

    const renderEdit = (container, snip) => {
      const form = document.createElement('div');
      form.className = 'zps-edit';
      const name = document.createElement('input');
      name.placeholder = '名称';
      name.value = snip.name || '';
      const tags = document.createElement('input');
      tags.placeholder = '标签（可选，空格分隔）';
      tags.value = snip.tags || '';
      const content = document.createElement('textarea');
      content.placeholder = '内容，支持 {{变量名}} 占位';
      content.value = snip.content || '';
      const row = document.createElement('div');
      row.className = 'zps-btnrow';
      const cancel = document.createElement('button');
      cancel.className = 'zps-btn zps-ghost';
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => {
        editing = null;
        render();
      });
      const save = document.createElement('button');
      save.className = 'zps-btn zps-primary';
      save.textContent = '保存';
      save.addEventListener('click', () => {
        if (!name.value.trim() || !content.value.trim()) {
          ui.showToast('名称与内容不能为空', 'warn');
          return;
        }
        if (snip.id) {
          Object.assign(snip, { name: name.value.trim(), tags: tags.value.trim(), content: content.value });
        } else {
          snippets.push({
            id: 's' + Date.now(),
            name: name.value.trim(),
            tags: tags.value.trim(),
            content: content.value,
            useCount: 0
          });
        }
        persist();
        editing = null;
        render();
        ui.showToast('已保存', 'success');
      });
      row.appendChild(cancel);
      row.appendChild(save);
      form.appendChild(name);
      form.appendChild(tags);
      form.appendChild(content);
      form.appendChild(row);
      container.appendChild(form);
    };

    const renderFill = (container, { snip }) => {
      const vars = [...new Set(placeholdersOf(snip.content))];
      const form = document.createElement('div');
      form.className = 'zps-edit';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;';
      title.textContent = `填充变量 · ${snip.name}`;
      form.appendChild(title);
      const inputs = {};
      for (const v of vars) {
        const input = document.createElement('input');
        input.placeholder = v;
        inputs[v] = input;
        form.appendChild(input);
      }
      const row = document.createElement('div');
      row.className = 'zps-btnrow';
      const back = document.createElement('button');
      back.className = 'zps-btn zps-ghost';
      back.textContent = '返回';
      back.addEventListener('click', () => {
        filling = null;
        render();
      });
      const insert = document.createElement('button');
      insert.className = 'zps-btn zps-primary';
      insert.textContent = '插入';
      insert.addEventListener('click', () => {
        const values = {};
        for (const v of vars) values[v] = inputs[v].value;
        if (insertText(fillPlaceholders(snip.content, values))) {
          snip.useCount = (snip.useCount || 0) + 1;
          persist();
          filling = null;
          panel.style.display = 'none';
          ui.showToast('已插入片段', 'success');
        }
      });
      row.appendChild(back);
      row.appendChild(insert);
      form.appendChild(row);
      container.appendChild(form);
    };

    const render = () => {
      panel.innerHTML = '';
      if (filling) {
        renderFill(panel, filling);
        return;
      }
      const head = document.createElement('div');
      head.className = 'zps-head';
      const search = document.createElement('input');
      search.className = 'zps-search';
      search.placeholder = '搜索片段…';
      search.value = query;
      search.addEventListener('input', () => {
        query = search.value;
        const list = panel.querySelector('.zps-list');
        if (list) {
          list.remove();
          renderList(panel);
        }
      });
      const add = document.createElement('button');
      add.className = 'zps-add';
      add.textContent = '+ 新建';
      add.addEventListener('click', () => {
        editing = { id: null, name: '', tags: '', content: '' };
        render();
      });
      head.appendChild(search);
      head.appendChild(add);
      panel.appendChild(head);

      if (editing) renderEdit(panel, editing);
      else renderList(panel);
    };

    const toggle = () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      if (panel.style.display === 'flex') {
        // 面板吸附 fab 上方（v1 行为），fab 自由拖拽后面板跟随
        const fr = fab.getBoundingClientRect();
        panel.style.right = Math.max(8, window.innerWidth - fr.right) + 'px';
        panel.style.bottom = Math.max(8, window.innerHeight - fr.top + 8) + 'px';
        render();
        panel.querySelector('.zps-search')?.focus();
      }
    };
    const onKey = (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    };
    document.addEventListener('keydown', onKey, true);

    cleanup(() => {
      document.removeEventListener('keydown', onKey, true);
      fab.remove();
      panel.remove();
    });
  },

  async stop() {
    /* teardown handled via ctx.cleanup */
  }
});
