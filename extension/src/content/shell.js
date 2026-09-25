/**
 * Shadow-DOM host, fonts, toast and the draft-collision dialog.
 */

/* global __TEST_BUILD__ */
import css from './panel.css';
import { h, icon } from '../ui/dom.js';

let root;

/** One closed shadow root holds all ContextPort UI on the page. */
export function shadow() {
  if (root?.host.isConnected) return root;
  const host = document.createElement('contextport-ui');
  host.setAttribute('data-contextport', '');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000; top: 0; left: 0; width: 0; height: 0;';
  (document.body || document.documentElement).append(host);
  // Closed so page scripts can't read or drive our UI. Test builds open it for automation.
  root = host.attachShadow({ mode: __TEST_BUILD__ ? 'open' : 'closed' });
  root.append(h('style', { text: css }));
  root.layer = h('div', { class: 'cp' });
  root.append(root.layer);
  loadFonts();
  return root;
}

export function layer() {
  return shadow().layer;
}

let fontsLoaded = false;
async function loadFonts() {
  if (fontsLoaded) return;
  fontsLoaded = true;
  // Loaded from bytes so page CSP font-src rules don't block them.
  const faces = [
    ['ContextPort Serif', 'fonts/newsreader-latin-300-normal.woff2', '300'],
    ['ContextPort Sans', 'fonts/inter-latin-400-normal.woff2', '400'],
    ['ContextPort Sans', 'fonts/inter-latin-500-normal.woff2', '500'],
    ['ContextPort Sans', 'fonts/inter-latin-600-normal.woff2', '600'],
  ];
  for (const [family, path, weight] of faces) {
    try {
      const buf = await (await fetch(chrome.runtime.getURL(path))).arrayBuffer();
      const face = new FontFace(family, buf, { weight, style: 'normal', display: 'swap' });
      await face.load();
      document.fonts.add(face);
    } catch {
      /* system fonts are the fallback */
    }
  }
}

/* ── toast ─────────────────────────────────────────────────────────── */

let toastEl;
let toastTimer;
/**
 * @param {string} message
 * @param {{action?: {label: string, run: () => void}, busy?: boolean, duration?: number}} [opts]
 */
export function toast(message, opts = {}) {
  clearTimeout(toastTimer);
  toastEl?.remove();
  toastEl = h(
    'div',
    { class: 'toast', role: 'status', 'aria-live': 'polite' },
    opts.busy ? h('span', { class: 'tspin' }) : null,
    h('span', { text: message }),
    opts.action ? h('button', { class: 'tbtn', text: opts.action.label, onclick: () => opts.action.run() }) : null,
  );
  layer().append(toastEl);
  const duration = opts.duration ?? (opts.action ? 12_000 : opts.busy ? 0 : 4_500);
  if (duration) toastTimer = setTimeout(() => toastEl?.remove(), duration);
}

export function hideToast() {
  toastEl?.remove();
}

/* ── existing-draft dialog ─────────────────────────────────────────── */

/** @returns {Promise<'replace'|'append'|'cancel'>} */
export function askAboutDraft(draft, platform) {
  return new Promise((resolve) => {
    const done = (v) => {
      scrim.remove();
      dlg.remove();
      resolve(v);
    };
    const scrim = h('div', { class: 'scrim', onclick: () => done('cancel') });
    const dlg = h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Message box already has text' },
      h('h3', { text: 'You have an unsent draft' }),
      h('p', { text: `The ${platform} message box already has text. ContextPort never overwrites your work without asking.` }),
      h('div', { class: 'draft', text: draft.length > 220 ? `${draft.slice(0, 220)}…` : draft }),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn primary', text: 'Add below draft', onclick: () => done('append') }),
        h('button', { class: 'btn', text: 'Replace', onclick: () => done('replace') }),
        h('button', { class: 'btn', text: 'Cancel', onclick: () => done('cancel') }),
      ),
    );
    layer().append(scrim, dlg);
    dlg.querySelector('button').focus();
  });
}

export { h, icon };
