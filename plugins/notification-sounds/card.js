/**
 * notification-sounds — custom settings section rendered inside the plugin's
 * own gear-button settings form.
 *
 * Invoked by the kernel via definePlugin's renderSettings hook (index.js
 * bridges to renderSoundSettings). Pure DOM + the plugin's own event channels;
 * all Tailwind class strings are copied verbatim from the kernel
 * (settings-page.js / renderer index.js) so the section renders first-party —
 * injected classes only have CSS if the official bundle generated them, so
 * nothing is invented here.
 */

import { EVENTS, CHANNELS } from './lib.js';

const PLUGIN_ID = 'notification-sounds';

// 与主进程 plugin-assets.js 的白名单/限额保持一致（客户端预检，省一次 RPC）
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm', 'opus'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/* ---- official class strings, verbatim from the kernel (do not tweak) ---- */
const SECTION_CLS = 'flex flex-col gap-3'; // settings-page.js 卡片段落间距
const SECTION_TITLE_CLS = 'text-ui-sm font-medium text-foreground-subtle'; // settings-page.js:788
const MUTED_XS_CLS = 'text-ui-xs text-foreground-subtle/80'; // settings-page.js:819
const ROW_CARD_CLS =
  'flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3'; // settings-page.js:843
const FORM_ROW_CLS =
  'flex flex-col gap-1.5 border-b border-border py-3 last:border-b-0'; // renderer index.js renderSettingsForm 非 inline 行
const LABEL_CLS = 'text-ui-base font-medium text-foreground'; // renderer index.js renderSettingsForm
const HEADER_CLS = 'flex items-center justify-between'; // settings-page.js:1024
const TEXT_BTN_CLS =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-ui-base text-foreground transition-colors hover:bg-surface-hover'; // settings-page.js textButton:1286
const ICON_BTN_CLS =
  'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground'; // settings-page.js iconButton:949
const ACTIONS_CLS = 'flex shrink-0 items-center gap-1'; // settings-page.js:855
const PRIMARY_BTN_CLS =
  'group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding whitespace-nowrap ' +
  'transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-50 ' +
  'bg-primary text-primary-foreground hover:bg-primary/80 h-7 gap-1 px-2 text-ui-base rounded-lg'; // settings-page.js OFFICIAL_PRIMARY_BTN:976
const INPUT_CLS =
  'h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-ui-base text-foreground outline-none transition-colors placeholder:text-foreground-subtle/60 focus-visible:ring-1 focus-visible:ring-input-border-focused'; // renderer index.js FORM_INPUT_CLS
const EMPTY_CLS =
  'rounded-xl border border-dashed border-border px-4 py-6 text-center text-ui-sm text-foreground-subtle'; // settings-page.js:827
const MUTED_SM_CLS = 'py-2 text-ui-sm text-foreground-subtle'; // renderer index.js 空表单提示同款

// 危险确认底色：与 settings-page.js removeConfirmBar:905 同款变量
const DESTRUCTIVE_BG = 'var(--color-destructive, #dc2626)';

// 图标：refresh/trash 与内核 settings-page.js ICONS 逐字一致；play 为同风格补绘
const ICONS = {
  refresh:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>',
  trash:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4"></path><path d="M16 6V4"></path></svg>',
  play:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>'
};

function iconSvg(name, cls = 'size-3.5') {
  return ICONS[name].replace('<svg ', `<svg class="${cls}" `);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function fmtDuration(ms) {
  const s = Number(ms) / 1000;
  if (!Number.isFinite(s) || s < 0) return '';
  const txt = s >= 10 ? String(Math.round(s)) : s.toFixed(1).replace(/\.0$/, '');
  return `${txt}s`;
}

function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

function extOf(name) {
  const dot = String(name ?? '').lastIndexOf('.');
  return dot >= 0 ? String(name).slice(dot + 1).toLowerCase() : '';
}

// 布局微调（drop 高亮）走 zns- 前缀注入样式；其余全部官方类
const ZNS_CSS = '.zns-drop-active{outline:2px dashed var(--color-primary, #8b5cf6);outline-offset:3px;border-radius:12px;}';

/**
 * Render the custom settings section into the kernel-provided container.
 *
 * @param {HTMLElement} el - container <div> handed over by renderSettingsForm
 * @param {object} helpers - kernel helpers { onChange, onAction, toast(msg, type) }
 * @param {object} deps - runtime snapshot supplied by index.js:
 *   invoke — RPC bridge (ctx.invoke)
 *   events — kernel event bus (emit only here; the libraryChanged listener
 *            lives in index.js, registered ONCE at start)
 *   ui — kernel UIManager (showToast fallback / injectStyle)
 *   getLibrary — () => current merged library array
 *   getSoundMap — () => current snap.soundMap
 *   isRunning — false → plugin not started: render the muted hint only
 *   onLibraryChanged — (fn) => void; register the re-render callback that
 *            index.js fires after its single libraryChanged listener reloads
 */
export function renderSoundSettings(el, helpers, deps) {
  try {
    const toast = (msg, type) => {
      if (typeof helpers?.toast === 'function') helpers.toast(msg, type);
      else deps.ui?.showToast?.(msg, type);
    };

    // 停用态（插件未启动但设置表单仍会渲染）：只出提示，不出管理 UI
    if (deps.isRunning === false) {
      el.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = MUTED_SM_CLS;
      hint.textContent = '插件已停用——启用后可管理音色库。';
      el.appendChild(hint);
      return;
    }

    try {
      deps.ui?.injectStyle?.('notification-sounds-card', ZNS_CSS);
    } catch {}

    /* ---------------- import pipeline ---------------- */

    async function importOne(file) {
      try {
        const ext = extOf(file.name);
        if (!AUDIO_EXTS.includes(ext)) return { name: file.name, ok: false, reason: '白名单外' };
        if (file.size > MAX_FILE_BYTES) return { name: file.name, ok: false, reason: '超限（>2MB）' };
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(reader.error || new Error('读取失败'));
          reader.readAsDataURL(file);
        });
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const res = await deps.invoke('plugin.writeAsset', { pluginId: PLUGIN_ID, name: file.name, base64 });
        if (res?.ok) return { name: file.name, ok: true, stored: res.name };
        const reasons = {
          quota: '配额（20MB 已满）',
          'File too large': '超限（>2MB）',
          'Invalid name': '文件名无法转为安全名',
          'Invalid base64 payload': '数据无效'
        };
        return { name: file.name, ok: false, reason: reasons[res?.error] || res?.error || '写入失败' };
      } catch (err) {
        return { name: file?.name || '?', ok: false, reason: err?.message || String(err) };
      }
    }

    async function handleFiles(fileList) {
      const files = [...(fileList || [])];
      if (files.length === 0) return;
      try {
        const results = await Promise.all(files.map(importOne));
        const ok = results.filter((r) => r.ok);
        const bad = results.filter((r) => !r.ok);
        const renamed = ok.some((r) => r.stored && r.stored !== r.name);
        let msg = `导入完成：成功 ${ok.length} 个`;
        if (renamed) msg += '（部分文件名已规范化）';
        if (bad.length > 0) {
          msg += `；失败 ${bad.length} 个：${bad.map((b) => `${b.name}（${b.reason}）`).join('、')}`;
        }
        toast(msg, bad.length > 0 ? (ok.length > 0 ? 'warn' : 'error') : 'success');
        deps.events.emit(CHANNELS.libraryChanged);
      } catch (err) {
        toast(`导入失败：${err?.message || err}`, 'error');
      }
    }

    /* ---------------- builders ---------------- */

    function makeTextButton(label, icon, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = TEXT_BTN_CLS;
      btn.innerHTML = icon ? `${iconSvg(icon)}<span>${esc(label)}</span>` : `<span>${esc(label)}</span>`;
      btn.addEventListener('click', onClick);
      return btn;
    }

    function makeSection(title, headerExtra) {
      const sec = document.createElement('div');
      sec.className = SECTION_CLS;
      if (title) {
        if (headerExtra) {
          const head = document.createElement('div');
          head.className = HEADER_CLS;
          const h = document.createElement('h3');
          h.className = SECTION_TITLE_CLS;
          h.textContent = title;
          head.appendChild(h);
          head.appendChild(headerExtra);
          sec.appendChild(head);
        } else {
          const h = document.createElement('h3');
          h.className = SECTION_TITLE_CLS;
          h.textContent = title;
          sec.appendChild(h);
        }
      }
      return sec;
    }

    function entryMeta(entry) {
      if (entry.scope === 'data') return `${fmtSize(entry.size)} · 导入音频`;
      const d = fmtDuration(entry.durationMs);
      return d ? `内置 · ${d}` : '内置';
    }

    function makePreviewButton(entry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = '试听';
      btn.setAttribute('aria-label', `试听 ${entry.name}`);
      btn.className = ICON_BTN_CLS;
      btn.innerHTML = iconSvg('play', 'size-4');
      btn.addEventListener('click', () => {
        try {
          deps.events.emit(CHANNELS.preview, entry.id);
        } catch (err) {
          console.error('[ZMod:NotifySounds] preview emit failed:', err);
        }
      });
      return btn;
    }

    function makeDeleteButton(entry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = TEXT_BTN_CLS;
      btn.innerHTML = `${iconSvg('trash')}<span>删除</span>`;
      let armed = false;
      let timer = null;
      const disarm = () => {
        armed = false;
        if (timer) clearTimeout(timer);
        timer = null;
        btn.disabled = false;
        btn.style.background = '';
        btn.style.color = '';
        btn.innerHTML = `${iconSvg('trash')}<span>删除</span>`;
      };
      btn.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          btn.textContent = '确认删除';
          btn.style.background = DESTRUCTIVE_BG;
          btn.style.color = '#ffffff';
          timer = setTimeout(disarm, 3000);
          return;
        }
        disarm();
        btn.disabled = true;
        try {
          const res = await deps.invoke('plugin.deleteAsset', { pluginId: PLUGIN_ID, name: entry.file });
          if (!res?.ok) {
            toast(res?.error === 'Not found' ? '文件不存在' : `删除失败：${res?.error || '未知错误'}`, 'error');
            btn.disabled = false;
            return;
          }
          // 清掉指向该音色的映射（含 default），避免残留失效引用
          const map = { ...(deps.getSoundMap() || {}) };
          let changed = false;
          for (const k of Object.keys(map)) {
            if (map[k] === entry.id) {
              map[k] = '';
              changed = true;
            }
          }
          if (changed) deps.events.emit(CHANNELS.mapChanged, map);
          deps.events.emit(CHANNELS.libraryChanged);
          toast(`已删除 ${entry.name}`, 'success');
        } catch (err) {
          btn.disabled = false;
          toast(`删除失败：${err?.message || err}`, 'error');
        }
      });
      return btn;
    }

    function buildLibrarySection(el2) {
      const lib = (deps.getLibrary() || []).slice();
      const refreshBtn = makeTextButton('刷新音色库', 'refresh', () => {
        deps.events.emit(CHANNELS.libraryChanged);
      });
      const sec = makeSection('音色库', refreshBtn);
      if (lib.length === 0) {
        const empty = document.createElement('div');
        empty.className = EMPTY_CLS;
        empty.textContent = '音色库为空';
        sec.appendChild(empty);
        el2.appendChild(sec);
        return;
      }
      for (const entry of lib) {
        const row = document.createElement('div');
        row.className = ROW_CARD_CLS;
        const info = document.createElement('div');
        info.className = 'min-w-0 flex-1';
        const name = document.createElement('div');
        name.className = 'truncate text-ui-base font-medium text-foreground';
        name.textContent = entry.name;
        const meta = document.createElement('div');
        meta.className = 'text-ui-xs text-foreground-subtle';
        meta.textContent = entryMeta(entry);
        info.appendChild(name);
        info.appendChild(meta);
        const actions = document.createElement('div');
        actions.className = ACTIONS_CLS;
        actions.appendChild(makePreviewButton(entry));
        if (entry.scope === 'data') actions.appendChild(makeDeleteButton(entry));
        row.appendChild(info);
        row.appendChild(actions);
        sec.appendChild(row);
      }
      el2.appendChild(sec);
    }

    function buildImportSection(el2) {
      const sec = makeSection('导入');
      const hint = document.createElement('div');
      hint.className = MUTED_XS_CLS;
      hint.textContent = '点击按钮或拖入音频文件；支持 mp3 / wav / ogg / m4a / aac / flac / webm / opus，单文件 ≤ 2MB，可多选。';
      sec.appendChild(hint);
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const files = input.files;
        handleFiles(files);
        input.value = '';
      });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = PRIMARY_BTN_CLS;
      btn.textContent = '导入音频文件';
      btn.addEventListener('click', () => input.click());
      sec.appendChild(btn);
      sec.appendChild(input);
      el2.appendChild(sec);
    }

    function buildMapSection(el2) {
      const sec = makeSection('事件音色');
      const cur = deps.getSoundMap() || {};
      const rows = document.createElement('div');
      for (const spec of [
        { key: 'default', label: '默认音色', followDefault: false },
        ...EVENTS.map((e) => ({ key: e.status, label: e.label, followDefault: true }))
      ]) {
        const row = document.createElement('div');
        row.className = FORM_ROW_CLS;
        const label = document.createElement('span');
        label.className = LABEL_CLS;
        label.textContent = spec.label;
        row.appendChild(label);
        const select = document.createElement('select');
        select.className = INPUT_CLS + ' cursor-pointer';
        if (spec.followDefault) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '跟随默认';
          select.appendChild(opt);
        }
        for (const entry of deps.getLibrary() || []) {
          const opt = document.createElement('option');
          opt.value = entry.id;
          opt.textContent = entry.name;
          select.appendChild(opt);
        }
        select.value = typeof cur[spec.key] === 'string' ? cur[spec.key] : '';
        // 当前值不在库里（如音色已删除）→ 回落到「跟随默认」/首个音色
        if (select.selectedIndex < 0) select.selectedIndex = 0;
        select.addEventListener('change', () => {
          try {
            const map = { ...(deps.getSoundMap() || {}) };
            map[spec.key] = select.value;
            deps.events.emit(CHANNELS.mapChanged, map);
          } catch (err) {
            console.error('[ZMod:NotifySounds] mapChanged emit failed:', err);
            toast(`设置失败：${err?.message || err}`, 'error');
          }
        });
        row.appendChild(select);
        rows.appendChild(row);
      }
      sec.appendChild(rows);
      el2.appendChild(sec);
    }

    function buildFooter(el2) {
      const note = document.createElement('div');
      note.className = MUTED_XS_CLS;
      note.textContent =
        '导入的音频保存在 ZMod 数据目录 plugin-data/notification-sounds/，插件更新与卸载不会清除。' +
        '接管后，官方设置中的“通知声音”开关不再生效（本插件接管放音）。';
      el2.appendChild(note);
    }

    function buildInto(el2) {
      el2.innerHTML = '';
      buildLibrarySection(el2);
      buildImportSection(el2);
      buildMapSection(el2);
      buildFooter(el2);
    }

    // 库变更 → index.js 的唯一 libraryChanged 监听回调这里登记的重绘；
    // 容器已断开（表单关闭）时跳过，避免白画。重复渲染覆盖旧回调，不叠监听。
    deps.onLibraryChanged?.(() => {
      if (!el.isConnected) return;
      try {
        buildInto(el);
      } catch (err) {
        console.error('[ZMod:NotifySounds] settings section rerender failed:', err);
      }
    });

    // drop zone：整区可拖入，高亮走 zns- 注入样式。重渲染复用同一容器
    // （innerHTML='' 不动 el 自身监听），用实例标记保证只挂一次。
    if (!el.__znsDropWired) {
      el.__znsDropWired = true;
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('zns-drop-active');
      });
      el.addEventListener('dragleave', () => el.classList.remove('zns-drop-active'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('zns-drop-active');
        handleFiles(e.dataTransfer?.files);
      });
    }

    buildInto(el);
  } catch (err) {
    console.error('[ZMod:NotifySounds] settings section render failed:', err);
    try {
      el.innerHTML = '';
      el.textContent = '通知声音设置区渲染失败，详见控制台';
    } catch {}
  }
}
