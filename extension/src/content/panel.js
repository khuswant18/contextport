/**
 * The Transfer sheet: move the conversation to another AI (or a fresh chat here).
 *
 * Flow: choose -> live progress -> check / edit / rate -> open, save or share.
 * On an empty chat (or from "Insert a saved brief") it lists recent briefs
 * instead, so context can be brought *into* this chat.
 */

import { h, icon, layer, toast } from './shell.js';
import { readConversation } from './adapters.js';
import { insertText, composerText } from './inject.js';
import { renderBrief, approxTokens } from '../ui/brief-view.js';
import { formatHandoff } from '../../../shared/format.js';
import { PLATFORMS } from '../../../shared/constants.js';

const ALL_DESTS = ['claude', 'chatgpt', 'gemini', 'perplexity'];
const MONO = { claude: 'Cl', chatgpt: 'Gp', gemini: 'Ge', perplexity: 'Px' };
const FEEDBACK_REASONS = [
  ['missed_requirements', 'Missed my requirements'],
  ['missing_code', 'Missing code'],
  ['wrong_latest', 'Wrong about where we left off'],
  ['inaccurate', 'Inaccurate'],
  ['too_long', 'Too long'],
  ['too_short', 'Too short'],
];

let open = null;

export function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) return reject(new Error('ContextPort was updated — please reload this page.'));
      if (!res?.ok) return reject(new Error(res?.error || 'Something went wrong'));
      resolve(res.data);
    });
  });
}

export function isPanelOpen() {
  return !!open;
}

// The launcher hides while the sheet is open. Our shadow DOM changes are
// invisible to the page's MutationObserver, so tell listeners directly.
const panelListeners = new Set();
export function onPanelChange(fn) {
  panelListeners.add(fn);
}
function panelChanged() {
  for (const fn of panelListeners) fn(!!open);
}

/**
 * @param {object} adapter
 * @param {{trigger?: string, destination?: string, fresh?: boolean, insert?: boolean}} [opts]
 */
export async function openPanel(adapter, opts = {}) {
  if (open) {
    open.close();
  }
  let ui = { engineLabel: 'ContextPort AI', defaultDestination: '', defaultMode: 'smart', detail: 'standard', includeAboutMe: false, hasAboutMe: false };
  let personal = { aboutMe: '' };
  let projects = [];
  try {
    [ui, personal, projects] = await Promise.all([send({ type: 'UI_SETTINGS' }), send({ type: 'GET_PERSONAL' }), send({ type: 'LIST_PROJECTS' })]);
  } catch {
    /* defaults */
  }
  send({ type: 'TRACK', name: 'panel_open', props: { source: adapter.id, trigger: opts.trigger || 'launcher' } }).catch(() => {});

  const others = ALL_DESTS.filter((d) => d !== adapter.id);
  const initialDest = opts.fresh ? adapter.id : others.includes(opts.destination) ? opts.destination : others.includes(ui.defaultDestination) ? ui.defaultDestination : others[0];
  const state = {
    dest: initialDest,
    scope: 'all',
    mode: ui.defaultMode === 'full' ? 'full' : 'smart',
    detail: ui.detail || 'standard',
    includeAboutMe: !!(ui.includeAboutMe && ui.hasAboutMe),
    projectId: '',
    moreOpen: false,
    packet: null,
    text: '',
    edited: false,
    editing: false,
    loading: false,
    error: null,
    reqId: 0,
    cache: new Map(),
    rated: null,
    savedId: null,
  };

  const lastFocus = document.activeElement;
  const scrim = h('div', { class: 'scrim', onclick: close });
  const titleEl = h('h2', { class: 'title', id: 'cp-title' });
  const eyebrow = h('div', { class: 'eyebrow' });
  const body = h('div', { class: 'body' });
  const foot = h('div', { class: 'foot' });
  const sheet = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cp-title', tabindex: '-1' },
    h('div', { class: 'head' }, h('div', { class: 'orb' }), eyebrow, titleEl, h('button', { class: 'close', 'aria-label': 'Close', onclick: close }, icon('close'))),
    body,
    foot,
  );
  layer().append(scrim, sheet);
  // Keep typing inside the sheet away from the host page's keyboard shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress']) sheet.addEventListener(type, (e) => e.key !== 'Escape' && e.stopPropagation());

  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);

  function close() {
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    sheet.remove();
    open = null;
    panelChanged();
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }
  open = { close, focus: () => sheet.focus() };
  panelChanged();

  /* ── helpers ──────────────────────────────────────────────────────── */

  const segmented = (label, options, current, onPick, extraClass = '') =>
    h(
      'div',
      { class: `seg ${extraClass}`, role: 'radiogroup', 'aria-label': label },
      options.map(([v, text]) => h('button', { role: 'radio', 'data-v': v, 'aria-checked': String(current === v), text, onclick: () => onPick(v) })),
    );

  const aboutMe = () => (state.includeAboutMe ? personal.aboutMe : '');

  function composeText() {
    if (!state.packet) return '';
    return formatHandoff(state.packet, state.dest, { aboutMe: aboutMe() });
  }

  function refreshText() {
    if (!state.edited) state.text = composeText();
  }

  /* ── controls ─────────────────────────────────────────────────────── */

  const controls = h('div', { class: 'controls' });
  const cardSlot = h('div');
  body.append(controls, cardSlot);

  function destGrid() {
    const dests = [...others, adapter.id];
    return h(
      'div',
      { class: `dests n${dests.length}`, role: 'radiogroup', 'aria-label': 'Destination' },
      dests.map((d) =>
        h(
          'button',
          {
            class: 'dest',
            role: 'radio',
            'data-v': d,
            'aria-checked': String(d === state.dest),
            onclick: () => {
              state.dest = d;
              renderControls();
              refreshText();
              renderCard();
              updateFooter();
            },
          },
          h('span', { class: 'mono', text: d === adapter.id ? '＋' : MONO[d] }),
          h('span', { class: 'dest-name', text: d === adapter.id ? `Fresh ${PLATFORMS[d].name} chat` : PLATFORMS[d].name }),
        ),
      ),
    );
  }

  function projectSelect() {
    if (state.newProject) {
      const input = h('input', { class: 'input', placeholder: 'Project name', 'aria-label': 'New project name', maxlength: '80' });
      const create = async () => {
        const name = input.value.trim();
        if (!name) return input.focus();
        try {
          const p = await send({ type: 'CREATE_PROJECT', name });
          projects = [p, ...projects];
          state.projectId = p.id;
        } catch (err) {
          toast(err.message);
        }
        state.newProject = false;
        renderControls();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // keep the host page's shortcuts out of our input
        if (e.key === 'Enter') create();
        if (e.key === 'Escape') ((state.newProject = false), renderControls());
      });
      queueMicrotask(() => input.focus());
      return h('div', { class: 'inline-new' }, input, h('button', { class: 'btn small', text: 'Create', onclick: create }));
    }
    return h(
      'select',
      {
        class: 'select',
        'aria-label': 'Project',
        onchange: (e) => {
          if (e.target.value === '__new') {
            state.newProject = true;
            renderControls();
            return;
          }
          state.projectId = e.target.value;
        },
      },
      h('option', { value: '', text: 'No project' }),
      projects.map((p) => h('option', { value: p.id, text: p.name, selected: p.id === state.projectId })),
      h('option', { value: '__new', text: '+ New project…' }),
    );
  }

  function renderControls() {
    const nodes = [];
    const scopes = [
      ['all', 'Whole chat'],
      ['recent', 'Last 10'],
      ['last', 'Last reply'],
    ];
    nodes.push(
      h('div', {}, h('div', { class: 'sec', text: 'Send to' }), destGrid()),
      h('div', {}, h('div', { class: 'sec', text: 'Include' }), segmented('What to include', scopes, state.scope, (v) => setOption('scope', v))),
      h('div', {}, h('div', { class: 'sec', text: 'Format' }), segmented('Format', [['smart', 'Smart brief'], ['full', 'Full transcript']], state.mode, (v) => setOption('mode', v))),
    );

    // More options
    const more = h(
      'div',
      { class: `more${state.moreOpen ? ' open' : ''}` },
      h(
        'button',
        {
          class: 'more-toggle',
          'aria-expanded': String(state.moreOpen),
          onclick: () => {
            state.moreOpen = !state.moreOpen;
            renderControls();
          },
        },
        'More options',
        icon('chevron'),
      ),
    );
    if (state.moreOpen) {
      const rows = [];
      if (state.mode === 'smart') {
        rows.push(
          h(
            'div',
            { class: 'opt-row' },
            h('span', { text: 'Brief length' }),
            segmented('Brief length', [['short', 'Short'], ['standard', 'Standard'], ['detailed', 'Detailed']], state.detail, (v) => setOption('detail', v), 'small'),
          ),
        );
      }
      rows.push(h('div', { class: 'opt-row' }, h('span', { text: 'Project' }), projectSelect()));
      rows.push(
        h(
          'div',
          { class: 'opt-row' },
          h('span', { text: 'Add my About me card' }),
          ui.hasAboutMe
            ? h('button', {
                class: 'switch',
                role: 'switch',
                'aria-checked': String(state.includeAboutMe),
                'aria-label': 'Add my About me card',
                onclick: () => {
                  state.includeAboutMe = !state.includeAboutMe;
                  if (state.includeAboutMe) send({ type: 'TRACK', name: 'about_me_used', props: { source: adapter.id } }).catch(() => {});
                  renderControls();
                  refreshText();
                  renderCard();
                },
              })
            : h('button', { class: 'link', text: 'Set it up', onclick: () => send({ type: 'OPEN_OPTIONS', section: 'about' }).catch(() => {}) }),
        ),
      );
      more.append(h('div', { class: 'opt-rows' }, rows));
    }
    nodes.push(more);
    controls.replaceChildren(...nodes);
    updateHeader();
  }

  function updateHeader() {
    eyebrow.textContent = `Transfer from ${adapter.name}`;
    titleEl.textContent = state.dest === adapter.id ? 'Start fresh, keep the context' : 'Continue this chat elsewhere';
  }

  function setOption(key, v) {
    if (state[key] === v) return;
    state[key] = v;
    renderControls();
    prepare();
  }

  /* ── footer ───────────────────────────────────────────────────────── */

  const saveBtn = h('button', { class: 'btn icon-only', title: 'Save to Library', 'aria-label': 'Save to Library', onclick: saveCheckpoint }, icon('bookmark'));
  const shareBtn = h('button', { class: 'btn icon-only', title: 'Create a share link', 'aria-label': 'Create a share link', onclick: shareLink }, icon('link'));
  const copyBtn = h('button', { class: 'btn icon-only', title: 'Copy text', 'aria-label': 'Copy text', onclick: copy }, icon('copy'));
  const goBtn = h('button', { class: 'btn primary', onclick: go });
  foot.append(saveBtn, shareBtn, copyBtn, goBtn);

  function updateFooter() {
    const fresh = state.dest === adapter.id;
    goBtn.replaceChildren(fresh ? `Open fresh ${PLATFORMS[state.dest].name} chat` : `Open in ${PLATFORMS[state.dest].name}`, icon('arrow'));
    const ready = !!state.packet && !state.loading && !!state.text;
    for (const b of [goBtn, copyBtn, saveBtn, shareBtn]) b.disabled = !ready;
    if (state.savedId && state.savedId === state.packet?.id) saveBtn.replaceChildren(icon('check'));
    else saveBtn.replaceChildren(icon('bookmark'));
  }

  /* ── preparation ──────────────────────────────────────────────────── */

  async function prepare(force = false) {
    const id = ++state.reqId;
    state.error = null;
    state.edited = false;
    state.editing = false;
    state.rated = null;

    if (adapter.isGenerating()) {
      state.packet = null;
      state.error = { kind: 'wait', message: `${adapter.name} is still writing its reply. Wait for it to finish, then try again.` };
      renderCard();
      updateFooter();
      return;
    }
    const { scope, mode } = state;
    const messages = readConversation(adapter, scope);
    if (!messages.length) {
      state.packet = null;
      showRecent(`There’s nothing to transfer from this ${adapter.name} chat yet. Start chatting — or bring in a brief you saved or sent earlier.`);
      return;
    }

    const last = messages[messages.length - 1].content;
    const key = `${scope}|${mode}|${state.detail}|${messages.length}|${last.length}`;
    if (!force && state.cache.has(key)) {
      state.packet = state.cache.get(key);
      state.loading = false;
      refreshText();
      renderCard();
      updateFooter();
      return;
    }

    state.loading = true;
    state.packet = null;
    state.progress = { count: messages.length, codeCount: messages.reduce((a, m) => a + (m.content.match(/```/g)?.length || 0) / 2, 0), mode };
    renderCard();
    updateFooter();

    try {
      const packet = await send({
        type: 'PREPARE',
        payload: { messages, title: conversationTitle(), url: location.href, mode, detail: state.detail },
      });
      if (id !== state.reqId || !open) return;
      state.cache.set(key, packet);
      state.packet = packet;
      refreshText();
      send({ type: 'TRACK', name: 'brief_ready', props: { source: adapter.id, processor: packet.processor, mode, detail: state.detail } }).catch(() => {});
    } catch (err) {
      if (id !== state.reqId || !open) return;
      state.error = { kind: 'error', message: err.message };
      send({ type: 'TRACK', name: 'brief_failed', props: { source: adapter.id } }).catch(() => {});
    } finally {
      if (id === state.reqId) {
        state.loading = false;
        renderCard();
        updateFooter();
      }
    }
  }

  /* ── card ─────────────────────────────────────────────────────────── */

  function engineRow() {
    const label = state.packet?.processorLabel || (state.mode === 'full' ? 'Full transcript' : ui.engineLabel);
    const aiOff = state.packet ? state.packet.processor === 'offline' || state.packet.processor === 'none' : false;
    return h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'engine' }, h('i', { class: `dot${aiOff ? ' off' : ''}` }), h('span', { text: label })),
      state.packet
        ? h('button', {
            class: 'link',
            text: state.editing ? 'Preview' : 'Edit text',
            onclick: () => {
              state.editing = !state.editing;
              renderCard();
            },
          })
        : null,
    );
  }

  function feedbackRow() {
    const pk = state.packet;
    if (!pk || pk.processor === 'none') return null;
    const rate = (rating, reasons = []) => {
      send({ type: 'FEEDBACK', rating, reasons, processor: pk.processor, mode: pk.mode, detail: state.detail }).catch(() => {});
    };
    if (state.rated === 'done') return h('div', { class: 'feedback thanks', text: 'Thanks — this helps make briefs better.' });
    if (state.rated === 'down') {
      const picked = new Set();
      return h(
        'div',
        { class: 'feedback' },
        h('div', { class: 'fb-q', text: 'What was wrong?' }),
        h(
          'div',
          { class: 'chips-select' },
          FEEDBACK_REASONS.map(([k, label]) =>
            h('button', {
              class: 'pick',
              'aria-pressed': 'false',
              text: label,
              onclick: (e) => {
                picked.has(k) ? picked.delete(k) : picked.add(k);
                e.currentTarget.setAttribute('aria-pressed', String(picked.has(k)));
              },
            }),
          ),
        ),
        h('div', { class: 'fb-actions' }, h('button', { class: 'link', text: 'Send', onclick: () => ((state.rated = 'done'), rate(-1, [...picked]), renderCard()) }), h('button', { class: 'link', text: 'Try again with more detail', onclick: () => ((state.detail = 'detailed'), rate(-1, [...picked]), renderControls(), prepare(true)) })),
      );
    }
    return h(
      'div',
      { class: 'feedback' },
      h('span', { class: 'fb-q', text: 'How is this brief?' }),
      h('button', { class: 'thumb', 'aria-label': 'Good brief', onclick: () => ((state.rated = 'done'), rate(1), renderCard()) }, icon('thumbUp')),
      h('button', { class: 'thumb', 'aria-label': 'Needs work', onclick: () => ((state.rated = 'down'), renderCard()) }, icon('thumbDown')),
    );
  }

  function renderCard() {
    const nodes = [];
    if (state.error) {
      nodes.push(
        h(
          'div',
          { class: `notice${state.error.kind === 'error' ? ' error' : ''}`, role: 'alert' },
          icon(state.error.kind === 'error' ? 'alert' : 'info'),
          h('div', {}, h('div', { text: state.error.message }), h('button', { class: 'link', text: 'Try again', onclick: () => prepare(true), style: { marginTop: '6px' } })),
        ),
      );
    } else if (state.loading) {
      const p = state.progress;
      const ai = p.mode === 'smart';
      nodes.push(
        h(
          'div',
          { class: 'card', 'aria-busy': 'true' },
          engineRow(),
          h(
            'ol',
            { class: 'steps' },
            h('li', { class: 'step done' }, h('span', { class: 'tick' }, icon('check')), `Read ${p.count} message${p.count === 1 ? '' : 's'}${p.codeCount >= 1 ? ` · ${Math.floor(p.codeCount)} code block${p.codeCount >= 2 ? 's' : ''}` : ''}`),
            h('li', { class: 'step active' }, h('span', { class: 'spin' }), ai ? 'Writing a brief of the conversation…' : 'Formatting the transcript…'),
            h('li', { class: 'step' }, h('span', { class: 'tick pending' }), 'Ready to review'),
          ),
          h('div', { style: { padding: '0 14px 16px', display: 'grid', gap: '8px' } }, h('div', { class: 'skeleton', style: { width: '70%' } }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: { width: '85%' } })),
        ),
      );
    } else if (state.packet) {
      const pk = state.packet;
      if (pk.notice) nodes.push(h('div', { class: 'notice', role: 'status' }, icon('info'), h('div', {}, h('div', { text: pk.notice }), h('button', { class: 'link', text: 'Try again', onclick: () => prepare(true), style: { marginTop: '6px' } }))));
      const content = state.editing
        ? h('textarea', {
            class: 'editor',
            'aria-label': 'Text to send',
            spellcheck: 'false',
            oninput: (e) => {
              state.text = e.target.value;
              state.edited = true;
              updateFooter();
            },
          })
        : h('div', { class: 'preview' }, renderBrief(pk));
      if (state.editing) content.value = state.text;
      const chips = [
        `${pk.stats?.messages ?? 0} messages`,
        pk.code?.length ? `${pk.code.length} code block${pk.code.length === 1 ? '' : 's'} kept` : null,
        approxTokens(state.text),
        state.includeAboutMe ? 'About me added' : null,
        state.edited ? 'Edited' : null,
      ].filter(Boolean);
      nodes.push(h('div', { class: 'card' }, engineRow(), content, h('div', { class: 'chips', style: { paddingTop: '12px' } }, chips.map((c) => h('span', { class: 'chip', text: c }))), feedbackRow()));
      if (state.editing) queueMicrotask(() => content.focus());
    }
    cardSlot.replaceChildren(...nodes);
  }

  /* ── actions ──────────────────────────────────────────────────────── */

  async function copy() {
    try {
      await navigator.clipboard.writeText(state.text);
      copyBtn.replaceChildren(icon('check'));
      setTimeout(() => copyBtn.replaceChildren(icon('copy')), 1600);
    } catch {
      toast('Copy was blocked by the browser. Use “Edit text” and copy manually.');
    }
  }

  async function saveCheckpoint() {
    if (!state.packet) return;
    try {
      await send({ type: 'SAVE_CHECKPOINT', packet: state.packet, projectId: state.projectId || null });
      state.savedId = state.packet.id;
      updateFooter();
      toast('Saved to your Library. Resume it any time from the toolbar icon.');
    } catch (err) {
      toast(err.message);
    }
  }

  async function shareLink() {
    if (!state.packet) return;
    shareBtn.disabled = true;
    shareBtn.replaceChildren(h('span', { class: 'spin' }));
    try {
      const link = await send({ type: 'CREATE_SHARE', packet: state.packet });
      state.savedId = state.packet.id;
      try {
        await navigator.clipboard.writeText(link.url);
        toast('Share link copied. Anyone with the link can read this brief for 7 days — it’s encrypted, even we can’t read it.', { duration: 7000 });
      } catch {
        toast(`Share link: ${link.url}`, { duration: 15000 });
      }
    } catch (err) {
      toast(err.message);
    } finally {
      shareBtn.disabled = false;
      updateFooter();
      shareBtn.replaceChildren(icon('link'));
    }
  }

  async function go() {
    if (!state.packet || !state.text) return;
    goBtn.disabled = true;
    goBtn.replaceChildren(h('span', { class: 'spin' }), `Opening ${PLATFORMS[state.dest].name}…`);
    try {
      await send({
        type: 'HANDOFF',
        payload: {
          packet: state.packet,
          destination: state.dest,
          text: state.text,
          projectId: state.projectId || null,
          trigger: opts.trigger || 'launcher',
          scope: state.scope,
        },
      });
      showDone();
    } catch (err) {
      state.error = { kind: 'error', message: err.message };
      renderCard();
      updateFooter();
    }
  }

  function showDone() {
    const name = PLATFORMS[state.dest].name;
    body.replaceChildren(
      h(
        'div',
        { class: 'done-state' },
        h('div', { class: 'done-mark' }, icon('check')),
        h('h3', { text: `Opened in ${name}` }),
        h('p', { text: `Your context is being added to ${name}'s message box in the new tab. Review it, then press send.` }),
      ),
    );
    foot.replaceChildren(h('button', { class: 'btn primary', text: 'Done', onclick: close }));
    setTimeout(() => open && close(), 4000);
  }

  /* ── bring context in: recent briefs ──────────────────────────────── */

  async function showRecent(intro) {
    controls.replaceChildren();
    foot.style.display = 'none';
    eyebrow.textContent = `ContextPort on ${adapter.name}`;
    titleEl.textContent = 'Bring in a saved brief';
    const list = h('div', { class: 'rb-list', 'aria-busy': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: { width: '80%' } }));
    cardSlot.replaceChildren(h('div', { class: 'notice', role: 'status' }, icon('info'), h('div', { text: intro })), h('div', { class: 'sec', style: { marginTop: '18px' }, text: 'Recent briefs' }), list);
    let items = [];
    try {
      items = await send({ type: 'RECENT_BRIEFS' });
    } catch {
      /* none */
    }
    if (!open) return;
    list.removeAttribute('aria-busy');
    if (!items.length) {
      list.replaceChildren(h('p', { class: 'rb-empty', text: 'Nothing saved yet. Briefs you transfer or save with the bookmark button will appear here.' }));
      return;
    }
    list.replaceChildren(
      ...items.map((it) =>
        h(
          'button',
          { class: 'rb-item', onclick: (e) => insertBrief(it, e.currentTarget) },
          h('span', { class: 'rb-text' }, h('span', { class: 'rb-title', text: it.title }), h('span', { class: 'rb-meta', text: `From ${PLATFORMS[it.source]?.name || 'an AI'} · ${ago(it.createdAt)}` })),
          h('span', { class: 'rb-go' }, 'Insert', icon('arrow')),
        ),
      ),
    );
  }

  async function insertBrief(it, button) {
    button.disabled = true;
    try {
      const text = await send({ type: 'BRIEF_TEXT', id: it.id });
      const box = adapter.composer();
      if (!box) throw new Error(`Couldn’t find the ${adapter.name} message box.`);
      await insertText(box, text, composerText(box).trim() ? 'append' : 'replace');
      close();
      toast(`Added “${it.title}” to the message box. Check it, then press send.`);
    } catch (err) {
      button.disabled = false;
      toast(err.message || 'Couldn’t insert that brief.');
    }
  }

  if (opts.insert) {
    sheet.focus();
    showRecent(`Pick a brief to add to this ${adapter.name} chat. Nothing is sent until you press send.`);
    return;
  }
  renderControls();
  updateFooter();
  sheet.focus();
  prepare();
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const d = Math.round(hrs / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function conversationTitle() {
  const t = (document.title || '').replace(/\s*[-|–]\s*(ChatGPT|Claude|Gemini|Google Gemini|Perplexity)\s*$/i, '').trim();
  return t && !/^(ChatGPT|Claude|Gemini|Google Gemini|Perplexity|New chat)$/i.test(t) ? t.slice(0, 200) : '';
}
