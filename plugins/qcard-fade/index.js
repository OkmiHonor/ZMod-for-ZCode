import { definePlugin } from '@zmod/sdk';

const QCF_THRESHOLD = 64;
const QCF_CARD = 'div[data-elicitation-dialog-card="true"]';
const QCF_BODY = '[data-elicitation-dialog-body="true"]';
const QCF_FOOT = '[data-elicitation-dialog-footer="true"]';
const QCF_SCROLLER = '[data-v4-timeline-scroll="true"]';
const QCF_COMPOSER_TAG = '[data-zmod-qcf-composer="1"]';

function clamp(v, def, min, max) {
  v = Number(v);
  if (!isFinite(v)) v = def;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function buildCSS(card, composer) {
  const rules = [];
  if (card) {
    rules.push(
      `${QCF_CARD} { transition: opacity .18s ease, backdrop-filter .18s ease; }`,
      `html[data-zmod-qcf-away="1"] ${QCF_CARD} { opacity: var(--zmod-qcf-away-op, .25) !important; backdrop-filter: blur(var(--zmod-qcf-away-blur, 0px)); }`,
      `html[data-zmod-qcf-away="1"] ${QCF_CARD}:hover { opacity: var(--zmod-qcf-hover-op, 1) !important; backdrop-filter: blur(var(--zmod-qcf-hover-blur, 12px)); }`,
      `html[data-zmod-qcf-away="1"][data-zmod-qcf-mode="collapse"] ${QCF_CARD}:not(:hover) ${QCF_BODY},`,
      `html[data-zmod-qcf-away="1"][data-zmod-qcf-mode="collapse"] ${QCF_CARD}:not(:hover) ${QCF_FOOT} { display: none !important; }`
    );
  }
  if (composer) {
    rules.push(
      `[data-zmod-qcf-composer="1"] { transition: opacity .18s ease, backdrop-filter .18s ease, height .18s ease; }`,
      `html[data-zmod-qcf-away="1"] ${QCF_COMPOSER_TAG}:not(:hover):not(:focus-within) { opacity: var(--zmod-qcf-away-op, .25) !important; backdrop-filter: blur(var(--zmod-qcf-away-blur, 0px)); }`,
      `html[data-zmod-qcf-away="1"] ${QCF_COMPOSER_TAG}:hover, html[data-zmod-qcf-away="1"] ${QCF_COMPOSER_TAG}:focus-within { opacity: var(--zmod-qcf-hover-op, 1) !important; backdrop-filter: blur(var(--zmod-qcf-hover-blur, 12px)); }`,
      `html[data-zmod-qcf-away="1"][data-zmod-qcf-mode="collapse"] ${QCF_COMPOSER_TAG}:not(:hover):not(:focus-within) { height: 14px !important; min-height: 14px !important; max-height: 14px !important; overflow: hidden !important; }`
    );
  }
  return rules.join('\n');
}

export default definePlugin({
  id: 'qcard-fade',
  name: '提问卡智能透明',
  description: '提问选择卡与底部输入框离底（翻历史）时自动淡出/折叠，悬停毛玻璃唤醒，聚焦恢复原生',
  version: '1.1.0-beta',
  author: 'ZMod Team',

  settings: {
    mode: {
      type: 'select',
      title: '离底形态',
      options: [
        { label: '淡出模式', value: 'fade' },
        { label: '折叠模式', value: 'collapse' }
      ],
      default: 'fade'
    },
    awayOpacity: {
      type: 'slider',
      title: '离底透明度 (%)',
      description: '往上翻历史时整卡淡到此透明度',
      default: 25,
      min: 5,
      max: 100
    },
    hoverOpacity: {
      type: 'slider',
      title: '悬停透明度 (%)',
      description: '悬停时的整卡透明度',
      default: 100,
      min: 30,
      max: 100
    },
    awayBlur: {
      type: 'slider',
      title: '离底背景模糊 (px)',
      description: '淡出同时把卡片后方内容糊化，0=关闭',
      default: 0,
      min: 0,
      max: 24
    },
    hoverBlur: {
      type: 'slider',
      title: '悬停背景模糊 (px)',
      description: '悬停时毛玻璃糊化底层文字，压住半透明叠加',
      default: 12,
      min: 0,
      max: 24
    },
    card: {
      type: 'switch',
      title: '作用于提问卡',
      default: true
    },
    composer: {
      type: 'switch',
      title: '作用于底部输入框',
      default: true
    }
  },

  async start(ctx) {
    const { settings, ui, cleanup } = ctx;
    let raf = 0;

    const applyVars = () => {
      const awayOp = (clamp(settings.get('awayOpacity', 25), 25, 5, 100) / 100).toFixed(2);
      const hoverOp = (clamp(settings.get('hoverOpacity', 100), 100, 30, 100) / 100).toFixed(2);
      const awayBlur = clamp(settings.get('awayBlur', 0), 0, 0, 24) + 'px';
      const hoverBlur = clamp(settings.get('hoverBlur', 12), 12, 0, 24) + 'px';
      const mode = settings.get('mode', 'fade');

      const st = document.documentElement.style;
      st.setProperty('--zmod-qcf-away-op', awayOp);
      st.setProperty('--zmod-qcf-hover-op', hoverOp);
      st.setProperty('--zmod-qcf-away-blur', awayBlur);
      st.setProperty('--zmod-qcf-hover-blur', hoverBlur);
      document.documentElement.setAttribute('data-zmod-qcf-mode', mode);

      ui.injectStyle('qcard-fade-css', buildCSS(settings.get('card', true), settings.get('composer', true)));
    };

    const check = () => {
      const card = document.querySelector(QCF_CARD);
      if (!card) {
        document.documentElement.removeAttribute('data-zmod-qcf-away');
      } else {
        let sc = card.closest(QCF_SCROLLER);
        if (!sc) {
          let n = card.parentElement;
          while (n && n !== document.body) {
            if (n.scrollHeight > n.clientHeight + 1) {
              const oy = getComputedStyle(n).overflowY;
              if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') { sc = n; break; }
            }
            n = n.parentElement;
          }
        }
        if (!sc) {
          document.documentElement.removeAttribute('data-zmod-qcf-away');
        } else {
          const isAway = (sc.scrollHeight - sc.scrollTop - sc.clientHeight) > QCF_THRESHOLD;
          if (isAway) document.documentElement.setAttribute('data-zmod-qcf-away', '1');
          else document.documentElement.removeAttribute('data-zmod-qcf-away');
        }
      }

      // Tag composer if enabled
      if (settings.get('composer', true)) {
        let composer = document.querySelector('[data-testid="v4-composer"]');
        if (!composer || !composer.querySelector('[data-lexical-editor="true"]')) {
          const editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"]');
          if (editor) {
            const layer = editor.closest('[data-testid="conversation-bottom-dock-transition"]') ||
                          editor.closest('[data-v4-composer-dock-content="true"]');
            if (layer) {
              let n = editor;
              while (n.parentElement && n.parentElement !== layer) n = n.parentElement;
              if (n && n.parentElement === layer) composer = n;
            }
          }
        }
        if (composer && !composer.hasAttribute('data-zmod-qcf-composer')) {
          composer.setAttribute('data-zmod-qcf-composer', '1');
        }
      }
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        check();
      });
    };

    applyVars();
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);

    // DOM changes (card mount/unmount, composer swap) re-evaluate on next frame
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { childList: true, subtree: true });

    ['mode', 'awayOpacity', 'hoverOpacity', 'awayBlur', 'hoverBlur', 'card', 'composer'].forEach((k) => {
      settings.onChange(k, () => {
        applyVars();
        schedule();
      });
    });

    schedule();

    cleanup(() => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      document.documentElement.removeAttribute('data-zmod-qcf-away');
      document.documentElement.removeAttribute('data-zmod-qcf-mode');
      ['--zmod-qcf-away-op', '--zmod-qcf-hover-op', '--zmod-qcf-away-blur', '--zmod-qcf-hover-blur'].forEach((k) => {
        document.documentElement.style.removeProperty(k);
      });
    });
  },

  async stop() {
    /* teardown handled via ctx.cleanup */
  }
});
