import { h, icon } from '../ui/dom.js';
import { send, timeAgo, activeTabStatus, openTransferInActiveTab, STATUS_LABEL, routeLabel } from '../ui/runtime.js';
import { renderBrief } from '../ui/brief-view.js';
import { PLATFORMS, platformName } from '../../../shared/constants.js';
import { exportMarkdown } from '../../../shared/format.js';

/**
 * Library: every transfer and checkpoint, on this device only.
 * Tabs: All · Saved · Projects. Detail views support resume, export, share and projects.
 */

const app = document.getElementById('app');
const state = { tab: 'all', query: '', items: [], projects: [], view: 'list' };

function flashNote(el, text, kind = 'ok') {
  el.replaceChildren(h('div', { class: `notice ${kind}`, text }));
  setTimeout(() => el.replaceChildren(), 5000);
}

function destSelect(selected) {
  return h(
    'select',
    { class: 'select', 'aria-label': 'Send to' },
    Object.values(PLATFORMS).map((p) => h('option', { value: p.id, text: p.name, selected: p.id === selected })),
  );
}

/* ── list ──────────────────────────────────────────────────────────── */

function header() {
  const input = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search your library',
    'aria-label': 'Search your library',
    value: state.query,
    oninput: (e) => {
      state.query = e.target.value;
      renderListBody();
    },
  });
  const tab = (id, label) =>
    h('button', {
      role: 'tab',
      'aria-selected': String(state.tab === id),
      text: label,
      onclick: () => {
        state.tab = id;
        showList();
      },
    });
  return h(
    'header',
    { class: 'top' },
    h(
      'div',
      { class: 'top-row' },
      h('div', {}, h('div', { class: 'eyebrow', text: 'ContextPort' }), h('h1', { class: 'display', text: 'Library' })),
      h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => chrome.runtime.openOptionsPage() }, icon('settings')),
    ),
    h('div', { class: 'search' }, icon('search'), input),
    h('div', { class: 'tabs', role: 'tablist' }, tab('all', 'All'), tab('saved', 'Saved'), tab('projects', 'Projects')),
  );
}

async function transferCard() {
  const { status } = await activeTabStatus();
  if (!status) return null;
  const ready = status.messages > 0 && !status.generating;
  return h(
    'section',
    { class: 'cta' },
    h('div', { class: 'orb' }),
    h('p', { text: ready ? `${status.name} chat · ${status.messages} messages` : `Open a ${status.name} conversation with at least one reply to transfer it.` }),
    h('button', { class: 'btn primary', disabled: !ready, onclick: openTransferInActiveTab }, icon('transfer'), 'Transfer current chat'),
  );
}

const listEl = h('ul', { class: 'list', 'aria-label': 'Library items' });

function kindChip(t) {
  if (t.kind === 'review') return 'Review'; // made by v3.2
  if (t.kind === 'checkpoint') return 'Saved';
  return STATUS_LABEL[t.status] || 'Sent';
}

function itemRow(t) {
  const project = state.projects.find((p) => p.id === t.projectId);
  const route = routeLabel(t.source, t.destination, platformName);
  return h(
    'li',
    {},
    h(
      'button',
      { class: 'item', onclick: () => showDetail(t.id) },
      h('div', { class: 'meta' }, h('span', { text: route }), h('span', { text: timeAgo(t.createdAt) })),
      h('div', { class: 't', text: t.title }),
      t.goal ? h('div', { class: 'g', text: t.goal }) : null,
      h('div', { class: 'tags' }, h('span', { class: 'chip', text: kindChip(t) }), project ? h('span', { class: 'chip', text: project.name }) : null, t.shared ? h('span', { class: 'chip', text: 'Shared' }) : null),
    ),
  );
}

function renderListBody() {
  const q = state.query.trim().toLowerCase();
  if (state.tab === 'projects') {
    const projects = q ? state.projects.filter((p) => p.name.toLowerCase().includes(q)) : state.projects;
    const newInput = h('input', { class: 'input', placeholder: 'New project name', 'aria-label': 'New project name', maxlength: '80' });
    const create = async () => {
      if (!newInput.value.trim()) return newInput.focus();
      await send({ type: 'CREATE_PROJECT', name: newInput.value });
      showList();
    };
    newInput.addEventListener('keydown', (e) => e.key === 'Enter' && create());
    listEl.replaceChildren(
      h('li', { class: 'new-project' }, newInput, h('button', { class: 'btn small', onclick: create }, icon('plus'), 'Create')),
      ...(projects.length
        ? projects.map((p) => {
            const n = state.items.filter((t) => t.projectId === p.id).length;
            return h(
              'li',
              {},
              h(
                'button',
                { class: 'item', onclick: () => showProject(p.id) },
                h('div', { class: 'meta' }, h('span', { text: `${n} item${n === 1 ? '' : 's'}` }), h('span', { text: timeAgo(p.updatedAt) })),
                h('div', { class: 't' }, icon('folder'), ' ', p.name),
              ),
            );
          })
        : [h('li', { class: 'empty' }, h('h2', { class: 'display', text: 'No projects yet' }), h('p', { text: 'Projects keep related chats together, so you can continue the whole project in any AI with its history.' }))]),
    );
    return;
  }
  let items = state.tab === 'saved' ? state.items.filter((t) => t.kind === 'checkpoint') : state.items;
  if (q) items = items.filter((t) => `${t.title} ${t.goal} ${t.source} ${t.destination}`.toLowerCase().includes(q));
  if (!state.items.length) {
    listEl.replaceChildren(
      h('li', { class: 'empty' }, h('h2', { class: 'display', text: 'Nothing here yet' }), h('p', { text: 'Every chat you transfer or save is kept here, on this device only, so you can resume it in any AI later.' })),
    );
    return;
  }
  listEl.replaceChildren(...(items.length ? items.map(itemRow) : [h('li', { class: 'empty', text: state.tab === 'saved' ? 'No saved checkpoints yet. Use the bookmark button in the Transfer panel.' : 'Nothing matches your search.' })]));
}

async function showList() {
  state.view = 'list';
  [state.items, state.projects] = await Promise.all([send({ type: 'LIST_HISTORY', limit: 200 }).catch(() => []), send({ type: 'LIST_PROJECTS' }).catch(() => [])]);
  app.replaceChildren(header(), state.tab === 'all' ? (await transferCard()) || '' : '', listEl);
  renderListBody();
}

/* ── export ────────────────────────────────────────────────────────── */

function slug(s) {
  return String(s || 'brief').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'brief';
}

function exportMenu(t, note) {
  const md = () => exportMarkdown(t.packet, t.createdAt);
  const title = t.packet.brief?.title || t.packet.source?.title || 'ContextPort brief';
  const track = () => send({ type: 'TRACK', name: 'export', props: { source: t.packet.source.platform } }).catch(() => {});
  return h(
    'div',
    { class: 'actions' },
    h('button', {
      class: 'btn small',
      onclick: () => {
        const url = URL.createObjectURL(new Blob([md()], { type: 'text/markdown' }));
        h('a', { href: url, download: `${slug(title)}.md` }).click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        track();
      },
    }, icon('download'), 'Markdown'),
    h('button', {
      class: 'btn small',
      onclick: async () => {
        await navigator.clipboard.writeText(md());
        track();
        flashNote(note, 'Markdown copied — paste it into Notion, Docs or any editor.');
      },
    }, icon('copy'), 'Copy Markdown'),
    h('button', {
      class: 'btn small',
      onclick: () => {
        const href = `obsidian://new?name=${encodeURIComponent(title.slice(0, 80))}&content=${encodeURIComponent(md())}`;
        h('a', { href }).click();
        track();
        flashNote(note, 'Opening Obsidian… (requires the Obsidian app).');
      },
    }, 'Obsidian'),
  );
}

/* ── detail ────────────────────────────────────────────────────────── */

async function showDetail(id) {
  state.view = 'detail';
  const t = await send({ type: 'GET_TRANSFER', id });
  if (!t) return showList();
  const note = h('div', { role: 'status', 'aria-live': 'polite' });
  const select = destSelect(t.destination || 'claude');
  let showText = false;
  const view = h('div', { class: 'card' }, renderBrief(t.packet));
  const toggle = h('button', {
    class: 'btn small',
    text: 'Show exact text',
    onclick: () => {
      showText = !showText;
      toggle.textContent = showText ? 'Show brief' : 'Show exact text';
      const ta = h('textarea', { class: 'text-view', readonly: true, 'aria-label': 'Exact text' });
      ta.value = t.text || '';
      view.replaceChildren(showText ? ta : renderBrief(t.packet));
    },
  });

  const shareBox = h('div', { class: 'share-box' });
  function renderShare(link) {
    if (!link) {
      shareBox.replaceChildren(
        h('button', {
          class: 'btn small',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              const l = await send({ type: 'CREATE_SHARE', id: t.id });
              t.share = l;
              renderShare(l);
              await navigator.clipboard.writeText(l.url).catch(() => {});
              flashNote(note, 'Link copied. It’s end-to-end encrypted and expires in 7 days.');
            } catch (err) {
              flashNote(note, err.message, 'error');
            }
          },
        }, icon('link'), 'Create share link'),
      );
      return;
    }
    const input = h('input', { class: 'input mono', readonly: true, value: link.url, 'aria-label': 'Share link', onfocus: (e) => e.target.select() });
    shareBox.replaceChildren(
      h('div', { class: 'share-row' }, input, h('button', { class: 'btn small', onclick: async () => (await navigator.clipboard.writeText(link.url), flashNote(note, 'Link copied.')) }, icon('copy'), 'Copy')),
      h('p', { class: 'hint' }, `Expires ${new Date(link.expiresAt).toLocaleDateString()}. `, h('button', {
        class: 'linkish',
        text: 'Revoke link',
        onclick: async () => {
          await send({ type: 'REVOKE_SHARE', id: t.id });
          t.share = null;
          renderShare(null);
          flashNote(note, 'Link revoked. It no longer works.');
        },
      })),
    );
  }
  renderShare(t.share && new Date(t.share.expiresAt) > new Date() ? t.share : null);

  const projects = await send({ type: 'LIST_PROJECTS' }).catch(() => []);
  const projectSel = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Project',
      onchange: async (e) => {
        await send({ type: 'SET_TRANSFER_PROJECT', id: t.id, projectId: e.target.value || null });
        flashNote(note, e.target.value ? 'Added to project.' : 'Removed from project.');
      },
    },
    h('option', { value: '', text: 'No project' }),
    projects.map((p) => h('option', { value: p.id, text: p.name, selected: p.id === t.projectId })),
  );

  const kindLabel = t.kind === 'review' ? 'Review request' : t.kind === 'checkpoint' ? 'Saved checkpoint' : 'Transfer';
  app.replaceChildren(
    h(
      'header',
      { class: 'top' },
      h('div', { class: 'top-row' }, h('button', { class: 'btn small ghost', onclick: showList }, icon('back'), 'Library'), h('span', { class: 'chip', text: kindLabel })),
    ),
    h(
      'div',
      { class: 'detail' },
      h('div', { class: 'eyebrow', text: `${platformName(t.packet.source.platform)}${t.destination ? ` → ${platformName(t.destination)}` : ''} · ${timeAgo(t.createdAt)}` }),
      h('div', { class: 'muted', style: { fontSize: '13px' }, text: t.packet.processorLabel || '' }),
      view,
      h('div', { class: 'sec-label', text: t.kind === 'checkpoint' ? 'Resume in' : 'Send again to' }),
      h(
        'div',
        { class: 'send-row' },
        select,
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            try {
              await send({ type: 'RESEND', id: t.id, destination: select.value });
              flashNote(note, `Opened ${PLATFORMS[select.value].name} in a new tab.`);
            } catch (err) {
              flashNote(note, err.message, 'error');
            }
          },
        }, t.kind === 'checkpoint' ? 'Resume' : 'Send', icon('arrow')),
      ),
      note,
      h('div', { class: 'sec-label', text: 'Share' }),
      shareBox,
      h('div', { class: 'sec-label', text: 'Export' }),
      exportMenu(t, note),
      h('div', { class: 'sec-label', text: 'Project' }),
      projectSel,
      h(
        'div',
        { class: 'actions', style: { marginTop: '8px' } },
        h('button', {
          class: 'btn small',
          onclick: async (e) => {
            await navigator.clipboard.writeText(t.text || '');
            e.currentTarget.replaceChildren(icon('check'), 'Copied');
          },
        }, icon('copy'), 'Copy text'),
        toggle,
        h('button', {
          class: 'btn small danger',
          onclick: async () => {
            await send({ type: 'DELETE_TRANSFER', id: t.id });
            showList();
          },
        }, icon('trash'), 'Delete'),
      ),
    ),
  );
}

/* ── project ───────────────────────────────────────────────────────── */

async function showProject(id) {
  state.view = 'project';
  let data;
  try {
    data = await send({ type: 'GET_PROJECT', id });
  } catch {
    return showList();
  }
  const { project, transfers } = data;
  const note = h('div', { role: 'status', 'aria-live': 'polite' });
  const select = destSelect('claude');
  const nameInput = h('input', { class: 'input title-input', value: project.name, 'aria-label': 'Project name', maxlength: '80' });
  nameInput.addEventListener('change', async () => {
    try {
      await send({ type: 'RENAME_PROJECT', id, name: nameInput.value });
      flashNote(note, 'Renamed.');
    } catch (err) {
      flashNote(note, err.message, 'error');
    }
  });

  app.replaceChildren(
    h('header', { class: 'top' }, h('div', { class: 'top-row' }, h('button', { class: 'btn small ghost', onclick: () => ((state.tab = 'projects'), showList()) }, icon('back'), 'Projects'), h('span', { class: 'chip', text: `${transfers.length} item${transfers.length === 1 ? '' : 's'}` }))),
    h(
      'div',
      { class: 'detail' },
      h('div', { class: 'eyebrow', text: 'Project' }),
      nameInput,
      transfers.length
        ? h(
            'div',
            { class: 'card project-cta' },
            h('p', { text: 'Continue this project in any AI: the latest brief plus a timeline of everything before it.' }),
            h(
              'div',
              { class: 'send-row' },
              select,
              h('button', {
                class: 'btn primary',
                onclick: async () => {
                  try {
                    await send({ type: 'RESEND_PROJECT', id, destination: select.value });
                    flashNote(note, `Opened ${PLATFORMS[select.value].name} with the project context.`);
                  } catch (err) {
                    flashNote(note, err.message, 'error');
                  }
                },
              }, 'Continue project', icon('arrow')),
            ),
          )
        : h('div', { class: 'notice', text: 'No items yet. In the Transfer panel, open “More options” and pick this project — or add items from their detail page.' }),
      note,
      h('ol', { class: 'timeline' }, transfers.map((t) => h('li', {}, h('button', { class: 'item', onclick: () => showDetail(t.id) }, h('div', { class: 'meta' }, h('span', { text: kindChip(t) }), h('span', { text: timeAgo(t.createdAt) })), h('div', { class: 't', text: t.title }), t.goal ? h('div', { class: 'g', text: t.goal }) : null)))),
      h('button', {
        class: 'btn small danger',
        onclick: async () => {
          if (!confirm(`Delete the project “${project.name}”? Its items stay in your Library.`)) return;
          await send({ type: 'DELETE_PROJECT', id });
          state.tab = 'projects';
          showList();
        },
      }, icon('trash'), 'Delete project'),
    ),
  );
}

showList();
// Refresh the "transfer current chat" card when the user switches tabs.
chrome.tabs.onActivated.addListener(() => state.view === 'list' && showList());
chrome.tabs.onUpdated.addListener((_, info) => state.view === 'list' && info.status === 'complete' && showList());
