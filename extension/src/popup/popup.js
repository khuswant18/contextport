import { h, icon } from '../ui/dom.js';
import { send, timeAgo, activeTabStatus, openTransferInActiveTab, STATUS_LABEL, routeLabel } from '../ui/runtime.js';
import { PLATFORMS, platformName } from '../../../shared/constants.js';
import { WHATS_NEW, formatMinutes } from '../ui/whats-new.js';

async function openInActiveTab(extra) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL', trigger: 'popup', ...extra });
    window.close();
  } catch {
    /* page not ready */
  }
}

const app = document.getElementById('app');

async function openSidePanel() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
  window.close();
}

function hero(status) {
  const box = h('section', { class: 'hero' }, h('div', { class: 'orb' }));
  if (status) {
    const ready = status.messages > 0 && !status.generating;
    box.append(
      h('div', { class: 'eyebrow', style: { position: 'relative' }, text: `On ${status.name}` }),
      h('h1', { class: 'display', text: ready ? 'Take this chat anywhere' : status.generating ? 'Waiting for the reply…' : 'Start a chat first' }),
      h('p', {
        text: ready
          ? `${status.messages} message${status.messages === 1 ? '' : 's'} ready. We'll write a brief and open it in the AI you choose.`
          : status.generating
            ? `${status.name} is still writing. You can transfer as soon as it finishes.`
            : `Once ${status.name} has replied you can move the chat to another AI — or bring a saved brief into this one now.`,
      }),
      ready || status.generating
        ? h(
            'button',
            {
              class: 'btn primary',
              disabled: !ready,
              onclick: async () => {
                if (await openTransferInActiveTab()) window.close();
              },
            },
            icon('transfer'),
            'Transfer this chat',
          )
        : h('button', { class: 'btn primary', onclick: () => openInActiveTab({ insert: true }) }, icon('bookmark'), 'Insert a saved brief'),
      ready
        ? h(
            'div',
            { class: 'quick' },
            h('button', { class: 'btn small', onclick: () => openInActiveTab({ fresh: true }) }, icon('refresh'), 'Fresh chat'),
            h('button', { class: 'btn small', onclick: () => openInActiveTab({ insert: true }) }, icon('bookmark'), 'Saved brief'),
          )
        : null,
    );
  } else {
    box.append(
      h('div', { class: 'eyebrow', style: { position: 'relative' }, text: 'ContextPort' }),
      h('h1', { class: 'display', text: 'Open an AI chat to begin' }),
      h('p', { text: 'Move a conversation between ChatGPT, Claude, Gemini and Perplexity — with your goal, decisions and code intact.' }),
      h(
        'div',
        { class: 'sites' },
        ['chatgpt', 'claude', 'gemini'].map((id) =>
          h('a', { class: 'btn small', href: PLATFORMS[id].newChatUrl, target: '_blank', rel: 'noopener', text: PLATFORMS[id].name }),
        ),
      ),
    );
  }
  return box;
}

async function engineRow() {
  const s = await send({ type: 'GET_SETTINGS' });
  const set = s.settings;
  const wrap = h('div', { style: { display: 'grid', gap: '8px' } });
  let label = 'ContextPort AI';
  if (set.engine === 'byok') label = `Your ${s.providers[set.provider]?.name || ''} key`;
  if (set.engine === 'offline') label = 'Offline mode (no AI)';
  const row = h(
    'div',
    { class: 'engine-row' },
    h('i', { class: `dot${set.engine === 'offline' ? ' off' : ''}` }),
    h('span', { text: label }),
    h('a', { href: '#', text: 'Change', onclick: (e) => (e.preventDefault(), chrome.runtime.openOptionsPage()) }),
  );
  wrap.append(row);
  if (set.engine === 'hosted') {
    const usage = await send({ type: 'GET_USAGE' }).catch(() => null);
    if (usage?.limit) {
      const left = Math.max(0, usage.limit - usage.used);
      row.querySelector('span').textContent = `ContextPort AI · ${left} of ${usage.limit} left today`;
      wrap.append(h('div', { class: 'meter', role: 'presentation' }, h('i', { style: { width: `${Math.min(100, (usage.used / usage.limit) * 100)}%` } })));
    }
  }
  return wrap;
}

async function recent() {
  const items = await send({ type: 'LIST_HISTORY', limit: 3 }).catch(() => []);
  const sec = h('section', { class: 'recent' }, h('h2', { class: 'eyebrow', text: 'Recent transfers' }));
  if (!items.length) {
    sec.append(h('div', { class: 'empty', text: 'Your transfers will appear here.' }));
    return sec;
  }
  for (const t of items) {
    sec.append(
      h(
        'button',
        { class: 'row', onclick: openSidePanel },
        h(
          'div',
          { class: 'row-main' },
          h('div', { class: 'route', text: `${routeLabel(t.source, t.destination, platformName)} · ${timeAgo(t.createdAt)}` }),
          h('div', { class: 'row-title', text: t.title }),
        ),
        h('span', { class: 'chip', text: STATUS_LABEL[t.status] || 'Sent' }),
      ),
    );
  }
  return sec;
}

async function whatsNewCard() {
  const wn = await send({ type: 'WHATS_NEW' }).catch(() => null);
  if (!wn) return null;
  const card = h(
    'section',
    { class: 'wn' },
    h('span', { class: 'badge', text: `New in ${wn.version}` }),
    h(
      'div',
      { class: 'wn-text' },
      h('strong', { text: WHATS_NEW.title, title: WHATS_NEW.title }),
      h('a', { href: '#', text: 'See what’s new', onclick: (e) => (e.preventDefault(), send({ type: 'DISMISS_WHATS_NEW' }), chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#whats-new') })) }),
    ),
    h('button', { class: 'x', 'aria-label': 'Dismiss', onclick: () => (send({ type: 'DISMISS_WHATS_NEW' }), card.remove()) }, icon('close')),
  );
  return card;
}

async function valueRow() {
  const st = await send({ type: 'STATS' }).catch(() => null);
  if (!st || !st.lifetime.transfers) return null;
  return h(
    'div',
    { class: 'value' },
    icon('clock'),
    h('span', {}, 'Saved you about ', h('strong', { text: formatMinutes(st.month.secondsSaved || 0) }), ` this month · ${st.month.transfers} transfer${st.month.transfers === 1 ? '' : 's'}`),
  );
}

function inviteRow() {
  return h(
    'button',
    { class: 'invite', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#invite') }) },
    icon('gift'),
    h('span', { text: 'Invite a friend — you both get +5 a day', title: 'You both get 5 extra free transfers every day' }),
    icon('arrow'),
  );
}

async function render() {
  const { status } = await activeTabStatus();
  const settings = (await send({ type: 'GET_SETTINGS' }).catch(() => null))?.settings;
  app.replaceChildren(
    h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, h('img', { src: '../icons/icon48.png', alt: '' }), 'ContextPort'),
      h('button', { class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', onclick: () => chrome.runtime.openOptionsPage() }, icon('settings')),
    ),
    (await whatsNewCard()) || '',
    hero(status),
    (await valueRow()) || '',
    await engineRow(),
    await recent(),
    settings?.engine === 'hosted' ? inviteRow() : '',
    h(
      'footer',
      { class: 'foot' },
      h('button', { class: 'btn small', onclick: openSidePanel }, icon('library'), 'Library'),
      h('button', { class: 'btn small', onclick: () => chrome.runtime.openOptionsPage() }, icon('settings'), 'Settings'),
    ),
  );
}

render().catch((err) => app.replaceChildren(h('div', { class: 'notice error', text: err.message })));
