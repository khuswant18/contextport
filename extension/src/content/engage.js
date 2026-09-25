/**
 * On-page engagement surfaces:
 *  - launcher + quick menu, first-run coachmark
 *  - usage-limit and long-chat nudges
 *  - snippet picker ("//" in the message box, or Alt+Shift+S) and About-me insert
 */

import { h, icon, layer, shadow, toast } from './shell.js';
import { openPanel, isPanelOpen, send } from './panel.js';
import { findLimitNotice } from './adapters.js';
import { insertText } from './inject.js';
import { PLATFORMS } from '../../../shared/constants.js';

const LONG_CHAT_MESSAGES = 40;
const LONG_CHAT_CHARS = 120_000;

/* ── launcher, menu, coachmark ─────────────────────────────────────── */

export function setupLauncher(adapter, ui) {
  if (ui.showLauncher === false) return { refresh() {} };

  const btn = h(
    'button',
    { class: 'launcher on', 'aria-label': 'Transfer this chat to another AI', title: 'Transfer this chat (Alt+Shift+T)', onclick: () => (closeMenu(), openPanel(adapter, { trigger: 'launcher' })) },
    icon('transfer'),
    h('span', { class: 'label', text: 'Transfer' }),
  );
  const menuBtn = h('button', { class: 'menu-btn on', 'aria-label': 'More ContextPort actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => toggleMenu() }, icon('chevron'));
  const wrap = h('div', { class: 'launcher-wrap' }, btn, menuBtn);
  layer().append(wrap);

  let menu = null;
  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    menuBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsidePage, true);
    shadow().removeEventListener('pointerdown', outsideUi, true);
  }
  // Our UI sits in a closed shadow root: a listener on the page only ever sees
  // the host element, never the menu inside it. So page-level clicks that hit
  // our host are left to the shadow-root listener, which sees the real target.
  function outsidePage(e) {
    if (!e.composedPath().includes(shadow().host)) closeMenu();
  }
  function outsideUi(e) {
    const path = e.composedPath();
    if (!path.includes(menu) && !path.includes(menuBtn)) closeMenu();
  }
  function item(iconName, label, run, kbd) {
    return h(
      'button',
      {
        role: 'menuitem',
        onclick: () => {
          closeMenu();
          run();
        },
      },
      icon(iconName),
      h('span', { text: label }),
      kbd ? h('span', { class: 'kbd', text: kbd }) : null,
    );
  }
  function toggleMenu() {
    if (menu) return closeMenu();
    menu = h(
      'div',
      { class: 'menu', role: 'menu', 'aria-label': 'ContextPort' },
      item('transfer', 'Continue in another AI', () => openPanel(adapter, { trigger: 'menu' }), 'Alt+Shift+T'),
      item('refresh', `Fresh ${adapter.name} chat with context`, () => openPanel(adapter, { trigger: 'menu', fresh: true })),
      item('bookmark', 'Insert a saved brief', () => openPanel(adapter, { trigger: 'menu', insert: true })),
      item('snippet', 'Insert a snippet', () => openSnippetPicker(adapter), 'Alt+Shift+S'),
      item('user', 'Insert my About me card', () => insertAboutMe(adapter)),
      item('library', 'Open Library', () => send({ type: 'OPEN_LIBRARY' }).catch((err) => toast(err.message))),
    );
    layer().append(menu);
    menuBtn.setAttribute('aria-expanded', 'true');
    menu.querySelector('button').focus();
    menu.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        closeMenu();
        menuBtn.focus();
        return;
      }
      const items = [...menu.querySelectorAll('button')];
      const i = items.indexOf(e.composedPath()[0]);
      if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
      if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
    });
    setTimeout(() => {
      if (!menu) return;
      document.addEventListener('pointerdown', outsidePage, true);
      shadow().addEventListener('pointerdown', outsideUi, true);
    });
  }

  let coached = !!ui.seen?.tip_launcher;
  function coach() {
    if (coached) return;
    coached = true;
    const el = h(
      'div',
      { class: 'coach', role: 'dialog', 'aria-label': 'ContextPort tip' },
      h('strong', { text: 'Take this chat anywhere' }),
      h('p', { text: 'Click Transfer to continue in Claude, ChatGPT or Gemini with a full brief. The arrow has snippets, saved briefs and more.' }),
      h('button', { text: 'Got it', onclick: () => el.remove() }),
    );
    layer().append(el);
    send({ type: 'MARK_SEEN', key: 'tip_launcher' }).catch(() => {});
    setTimeout(() => el.remove(), 20_000);
  }

  return {
    /** Always visible (empty chats included) except while the sheet is open. */
    refresh(hasReply) {
      const on = !isPanelOpen();
      btn.classList.toggle('on', on);
      menuBtn.classList.toggle('on', on);
      if (!on) closeMenu();
      if (!wrap.isConnected) layer().append(wrap);
      if (on && hasReply) coach();
    },
  };
}

/* ── nudges ────────────────────────────────────────────────────────── */

let bannerEl = null;
function banner({ title, text, actions }) {
  bannerEl?.remove();
  bannerEl = h(
    'div',
    { class: 'banner', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'b-text' }, h('strong', { text: title }), h('span', { text })),
    h('div', { class: 'b-actions' }, actions),
    h('button', { class: 'x', 'aria-label': 'Dismiss', onclick: () => bannerEl?.remove() }, icon('close')),
  );
  layer().append(bannerEl);
  setTimeout(() => bannerEl?.remove(), 45_000);
}

export function setupNudges(adapter, ui) {
  if (ui.detectLimits === false) return () => {};
  const others = ['claude', 'chatgpt', 'gemini'].filter((d) => d !== adapter.id);
  let limitShown = false;
  const longAsked = new Set(); // paths already offered the long-chat nudge

  return async function check(messages) {
    // Usage limit reached -> offer to continue elsewhere.
    if (!limitShown) {
      const notice = findLimitNotice(adapter);
      if (notice) {
        limitShown = true;
        if (await send({ type: 'NUDGE_CHECK', kind: 'limit', key: location.pathname }).catch(() => false)) {
          banner({
            title: `Hit ${adapter.name}'s limit?`,
            text: 'Keep going in another AI — your goal, decisions and code come with you.',
            actions: others.map((d) =>
              h('button', {
                class: `btn${d === others[0] ? ' primary' : ''}`,
                text: `Continue in ${PLATFORMS[d].name}`,
                onclick: () => (bannerEl?.remove(), openPanel(adapter, { trigger: 'limit', destination: d })),
              }),
            ),
          });
        }
        return;
      }
    }
    // Very long chat -> suggest a fresh start with a brief.
    if (messages && !longAsked.has(location.pathname) && (messages.count >= LONG_CHAT_MESSAGES || messages.chars >= LONG_CHAT_CHARS)) {
      longAsked.add(location.pathname);
      if (await send({ type: 'NUDGE_CHECK', kind: 'long_chat', key: location.pathname }).catch(() => false)) {
        banner({
          title: 'This chat is getting long',
          text: 'Very long chats can make answers slower and less accurate. Start fresh with a brief of everything so far.',
          actions: [
            h('button', { class: 'btn primary', text: 'Start fresh with a brief', onclick: () => (bannerEl?.remove(), openPanel(adapter, { trigger: 'long_chat', fresh: true })) }),
            h('button', { class: 'btn', text: 'Save a checkpoint', onclick: () => (bannerEl?.remove(), openPanel(adapter, { trigger: 'long_chat' })) }),
          ],
        });
      }
    }
  };
}

/* ── snippets & About me ───────────────────────────────────────────── */

let pickerEl = null;
let pickerOpening = null; // in-flight open, so fast typing can't open two pickers

function composerRect(adapter) {
  const c = adapter.composer();
  return c ? c.getBoundingClientRect() : { left: window.innerWidth / 2 - 160, top: window.innerHeight - 120 };
}

/**
 * @param {object} adapter
 * @param {{query?: string, onPick?: (snippet) => void}} [opts]
 */
export async function openSnippetPicker(adapter, opts = {}) {
  closePicker();
  let snippets = [];
  try {
    ({ snippets } = await send({ type: 'GET_PERSONAL' }));
  } catch {
    /* none */
  }
  let q = opts.query || '';
  let index = 0;
  const list = h('div', { role: 'listbox', 'aria-label': 'Snippets' });
  const picker = h('div', { class: 'picker' }, h('div', { class: 'p-head', text: 'Snippets · ↑↓ Enter · Esc' }), list);
  pickerEl = picker;

  const filtered = () => snippets.filter((s) => `${s.name} ${s.text}`.toLowerCase().includes(q.toLowerCase()));
  function draw() {
    const items = filtered();
    index = Math.min(index, Math.max(0, items.length - 1));
    list.replaceChildren(
      ...(items.length
        ? items.map((s, i) =>
            h(
              'button',
              { role: 'option', 'aria-selected': String(i === index), onmousedown: (e) => e.preventDefault(), onclick: () => pick(s) },
              h('div', { class: 'p-name', text: s.name }),
              h('div', { class: 'p-text', text: s.text }),
            ),
          )
        : [
            h('div', { class: 'p-empty', text: snippets.length ? 'No snippet matches.' : 'No snippets yet.' }),
            h('button', { onmousedown: (e) => e.preventDefault(), onclick: () => (closePicker(), send({ type: 'OPEN_OPTIONS', section: 'snippets' })) }, h('div', { class: 'p-name', text: 'Add snippets in Settings' })),
          ]),
    );
  }
  async function pick(s) {
    closePicker();
    send({ type: 'TRACK', name: 'snippet_used', props: { source: adapter.id } }).catch(() => {});
    if (opts.onPick) return opts.onPick(s);
    const box = adapter.composer();
    if (!box) return toast(`Couldn't find the ${adapter.name} message box.`);
    await insertText(box, s.text, 'append').catch(() => toast('Couldn’t insert the snippet here.'));
  }

  const r = composerRect(adapter);
  picker.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 330))}px`;
  picker.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
  layer().append(picker);
  draw();
  setTimeout(() => {
    if (pickerEl !== picker) return;
    document.addEventListener('pointerdown', pickerOutsidePage, true);
    shadow().addEventListener('pointerdown', pickerOutsideUi, true);
  });

  picker.controls = {
    setQuery(v) {
      q = v;
      index = 0;
      draw();
    },
    key(e) {
      const items = filtered();
      if (e.key === 'ArrowDown') index = (index + 1) % Math.max(1, items.length);
      else if (e.key === 'ArrowUp') index = (index - 1 + items.length) % Math.max(1, items.length);
      else if (e.key === 'Enter' || e.key === 'Tab') {
        if (items[index]) pick(items[index]);
        return true;
      } else if (e.key === 'Escape') {
        closePicker();
        return true;
      } else return false;
      draw();
      return true;
    },
  };
  return picker;
}

// Same closed-shadow-root rule as the menu: page listeners only see our host.
function pickerOutsidePage(e) {
  if (!e.composedPath().includes(shadow().host)) closePicker();
}
function pickerOutsideUi(e) {
  if (pickerEl && !e.composedPath().includes(pickerEl)) closePicker();
}

export function closePicker() {
  pickerEl?.remove();
  pickerEl = null;
  document.removeEventListener('pointerdown', pickerOutsidePage, true);
  shadow().removeEventListener('pointerdown', pickerOutsideUi, true);
}

/**
 * "//" trigger inside the composer: typing `//` (optionally followed by a
 * filter) opens the picker; choosing a snippet replaces the trigger text.
 */
export function setupSnippetTrigger(adapter) {
  const TRIGGER = /(?:^|\s)\/\/([\w-]{0,24})$/;

  function textBeforeCaret(box) {
    if (box.tagName === 'TEXTAREA') return box.value.slice(0, box.selectionStart);
    const sel = window.getSelection();
    if (!sel.rangeCount || !box.contains(sel.anchorNode)) return '';
    const range = sel.getRangeAt(0).cloneRange();
    range.setStart(box, 0);
    return range.toString();
  }

  function removeTrigger(box, len) {
    if (box.tagName === 'TEXTAREA') {
      const end = box.selectionStart;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, box.value.slice(0, end - len) + box.value.slice(end));
      box.selectionStart = box.selectionEnd = end - len;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    for (let i = 0; i < len; i++) document.execCommand('delete', false);
  }

  document.addEventListener(
    'input',
    (e) => {
      const box = adapter.composer();
      if (!box || !(e.target === box || box.contains(e.target))) return;
      const m = TRIGGER.exec(textBeforeCaret(box));
      if (!m) {
        if (pickerEl?.fromTrigger) closePicker();
        return;
      }
      if (pickerOpening) {
        pickerOpening.then((p) => p.controls.setQuery(m[1]));
        return;
      }
      if (pickerEl?.fromTrigger) {
        pickerEl.controls.setQuery(m[1]);
        return;
      }
      pickerOpening = openSnippetPicker(adapter, {
        query: m[1],
        onPick: async (s) => {
          box.focus();
          // Measure the trigger now: the user may have typed more since the picker opened.
          const now = TRIGGER.exec(textBeforeCaret(box));
          removeTrigger(box, now ? 2 + now[1].length : 0);
          if (box.tagName === 'TEXTAREA') {
            const pos = box.selectionStart;
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(box, box.value.slice(0, pos) + s.text + box.value.slice(pos));
            box.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            document.execCommand('insertText', false, s.text);
          }
        },
      }).then((p) => {
        p.fromTrigger = true;
        pickerOpening = null;
        return p;
      });
    },
    true,
  );

  // Arrow/Enter/Escape drive the picker while it's open (before the site sees them).
  document.addEventListener(
    'keydown',
    (e) => {
      if (!pickerEl?.controls) return;
      if (pickerEl.controls.key(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}

export async function insertAboutMe(adapter) {
  const { aboutMe } = await send({ type: 'GET_PERSONAL' }).catch(() => ({ aboutMe: '' }));
  if (!aboutMe.trim()) {
    toast('You haven’t written an About me card yet.', { action: { label: 'Set it up', run: () => send({ type: 'OPEN_OPTIONS', section: 'about' }) } });
    return;
  }
  const box = adapter.composer();
  if (!box) return toast(`Couldn't find the ${adapter.name} message box.`);
  await insertText(box, `About me:\n${aboutMe.trim()}`, 'append').catch(() => toast('Couldn’t insert here.'));
  send({ type: 'TRACK', name: 'about_me_used', props: { source: adapter.id } }).catch(() => {});
}
