import { h, icon } from '../ui/dom.js';
import { send } from '../ui/runtime.js';
import { PLATFORMS } from '../../../shared/constants.js';
import { renderBrief } from '../ui/brief-view.js';
import { WHATS_NEW } from '../ui/whats-new.js';
import { API_BASE } from '../config.js';

/**
 * Settings page. Each section re-renders on its own, so changing one control
 * never closes another (e.g. picking a provider keeps the key/model panel open).
 */

const app = document.getElementById('app');
let view; // { settings, keys, providers, modelLists } from the service worker
const ui = {
  engine: 'hosted', // what's selected on screen (may differ from saved until a key is verified)
  provider: 'openai',
  model: '',
  keyDraft: '',
  detected: null,
  busy: false,
  result: null, // last verify result
  usage: null,
};

const toastEl = h('div', { class: 'saved', role: 'status', 'aria-live': 'polite' });
document.body.append(toastEl);
function flash(text = 'Saved') {
  toastEl.textContent = text;
  toastEl.classList.add('on');
  clearTimeout(flash.t);
  flash.t = setTimeout(() => toastEl.classList.remove('on'), 1800);
}

async function saveSettings(patch, message) {
  view = { ...view, ...(await send({ type: 'SAVE_SETTINGS', patch })) };
  if (message) flash(message);
}

const savedModel = (provider) => view.settings.models?.[provider] || '';
const modelsFor = (provider) => view.modelLists?.[provider]?.length ? view.modelLists[provider] : view.providers[provider].examples;

/* ── engine cards ───────────────────────────────────────────────────── */

const enginesSlot = h('div', { class: 'engines', role: 'radiogroup', 'aria-label': 'AI engine' });
const byokSlot = h('div');

function engineCard(id, title, badge, desc) {
  return h(
    'button',
    {
      class: 'engine',
      role: 'radio',
      'aria-checked': String(ui.engine === id),
      onclick: async () => {
        ui.engine = id;
        renderEngines();
        renderByok();
        if (id !== 'byok') await saveSettings({ engine: id }, 'AI engine updated');
        else if (view.keys[ui.provider]) await saveSettings({ engine: 'byok', provider: ui.provider }, 'Using your own key');
        else document.getElementById('key-input')?.focus();
      },
    },
    h('span', { class: 'radio' }),
    h('div', {}, h('h3', {}, title, badge ? h('span', { class: 'badge', text: badge }) : null), h('p', { text: desc })),
  );
}

function renderEngines() {
  const left = ui.usage?.limit ? `${Math.max(0, ui.usage.limit - ui.usage.used)} of ${ui.usage.limit} free transfers left today` : 'Free daily transfers';
  enginesSlot.replaceChildren(
    engineCard('hosted', 'ContextPort AI', 'Free', `No setup needed. ${left}.`),
    engineCard('byok', 'Your own API key', 'Unlimited', 'OpenAI, Claude, Gemini, Groq, OpenRouter, DeepSeek, Mistral, xAI or Together — any model your key can use.'),
    engineCard('offline', 'Offline', null, 'No AI. A basic brief is built on your device from your messages, plus the exact code.'),
  );
}

/* ── bring-your-own-key panel ───────────────────────────────────────── */

function stepRow(state, label) {
  const mark = state === 'ok' ? icon('check') : state === 'fail' ? icon('alert') : state === 'busy' ? h('span', { class: 'spin' }) : h('span', { class: 'pending-dot' });
  return h('li', { class: `vstep ${state}` }, h('span', { class: 'vmark' }, mark), h('span', { text: label }));
}

function resultBlock() {
  const r = ui.result;
  const p = view.providers[ui.provider];
  if (ui.busy) {
    return h('ol', { class: 'vsteps', 'aria-live': 'polite' }, stepRow('busy', `Checking your ${p.name} key…`), stepRow('pending', `Looking up "${ui.model}"`), stepRow('pending', 'Sending a tiny test request'));
  }
  if (!r) return null;
  if (r.ok) {
    return h(
      'ol',
      { class: 'vsteps', 'aria-live': 'polite' },
      stepRow('ok', 'API key is valid'),
      stepRow('ok', r.listed ? `"${r.model}" is available to this key` : `"${r.model}" works with this key`),
      stepRow('ok', `Test request answered in ${(r.latencyMs / 1000).toFixed(1)}s — you're all set`),
    );
  }
  const stages = ['key', 'model', 'request'];
  const failAt = stages.indexOf(r.stage);
  const labels = ['API key', `Model "${ui.model}"`, 'Test request'];
  return h(
    'div',
    { 'aria-live': 'polite' },
    h('ol', { class: 'vsteps' }, stages.map((st, i) => stepRow(i < failAt ? 'ok' : i === failAt ? 'fail' : 'pending', i === failAt ? r.message : labels[i]))),
    r.suggestions?.length
      ? h(
          'div',
          { class: 'suggest' },
          h('span', { class: 'muted', text: 'Did you mean:' }),
          r.suggestions.map((m) =>
            h('button', {
              class: 'chip-btn',
              text: m,
              onclick: () => {
                ui.model = m;
                runVerify();
              },
            }),
          ),
        )
      : null,
  );
}

function renderByok() {
  if (ui.engine !== 'byok') {
    byokSlot.replaceChildren();
    return;
  }
  const provider = ui.provider;
  const p = view.providers[provider];
  const saved = view.keys[provider];
  const active = view.settings.engine === 'byok' && view.settings.provider === provider && saved;
  const listId = 'model-options';

  const providerSelect = h(
    'select',
    {
      class: 'select',
      id: 'provider',
      onchange: async (e) => {
        ui.provider = e.target.value;
        ui.model = savedModel(ui.provider) || view.providers[ui.provider].examples[0];
        ui.result = null;
        ui.detected = null;
        renderByok();
        // Switch the active provider right away only if it already has a verified key.
        if (view.settings.engine === 'byok' && view.keys[ui.provider]) await saveSettings({ provider: ui.provider }, `Now using ${view.providers[ui.provider].name}`);
      },
    },
    Object.entries(view.providers).map(([id, pr]) => h('option', { value: id, text: pr.name + (view.keys[id] ? '  ✓' : ''), selected: id === provider })),
  );

  const modelInput = h('input', {
    class: 'input mono',
    id: 'model',
    list: listId,
    value: ui.model,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: `Type or pick a model, e.g. ${p.examples[0]}`,
    oninput: (e) => {
      ui.model = e.target.value.trim();
      ui.result = null;
      resultSlot.replaceChildren();
      syncButton();
    },
    onkeydown: (e) => e.key === 'Enter' && runVerify(),
  });
  const datalist = h('datalist', { id: listId }, modelsFor(provider).map((m) => h('option', { value: m })));

  const keyInput = h('input', {
    class: 'input mono',
    id: 'key-input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    value: ui.keyDraft,
    placeholder: saved ? `Saved key ${saved} — paste a new one to replace it` : `Paste your ${p.name} key (${p.keyHint})`,
    'aria-label': `${p.name} API key`,
    oninput: async (e) => {
      ui.keyDraft = e.target.value.trim();
      ui.result = null;
      resultSlot.replaceChildren();
      syncButton();
      const detected = ui.keyDraft.length > 8 ? await send({ type: 'DETECT_PROVIDER', key: ui.keyDraft }).catch(() => null) : null;
      if (detected && detected !== ui.provider) {
        ui.provider = detected;
        ui.model = savedModel(detected) || view.providers[detected].examples[0];
        ui.detected = detected;
        renderByok();
        document.getElementById('key-input')?.focus();
      }
    },
    onkeydown: (e) => e.key === 'Enter' && runVerify(),
  });

  const verifyBtn = h('button', { class: 'btn primary', id: 'verify-btn', onclick: runVerify });
  function syncButton() {
    const label = ui.keyDraft ? 'Save & verify' : saved ? (active && ui.model === savedModel(provider) ? 'Check again' : 'Verify & use') : 'Save & verify';
    verifyBtn.replaceChildren(...(ui.busy ? [h('span', { class: 'spin' })] : []), label);
    verifyBtn.disabled = ui.busy || (!ui.keyDraft && !saved) || !ui.model;
  }
  syncButton();

  const resultSlot = h('div', { class: 'result-slot' });
  const res = resultBlock();
  if (res) resultSlot.append(res);

  byokSlot.replaceChildren(
    h(
      'div',
      { class: 'card byok' },
      active ? h('div', { class: 'notice ok' }, icon('check'), `Transfers use your ${p.name} key · ${savedModel(provider)}`) : null,
      h(
        'div',
        { class: 'grid2' },
        h('div', {}, h('label', { class: 'field-label', for: 'provider', text: 'Provider' }), providerSelect),
        h(
          'div',
          {},
          h('label', { class: 'field-label', for: 'model', text: 'Model' }),
          modelInput,
          datalist,
          h('p', { class: 'hint', text: view.modelLists?.[provider]?.length ? `${view.modelLists[provider].length} models found for your key. Type any of them.` : 'Type any model id your key can use.' }),
        ),
      ),
      h(
        'div',
        {},
        h('label', { class: 'field-label', for: 'key-input', text: 'API key' }),
        h('div', { class: 'key-row' }, keyInput, verifyBtn),
        h(
          'p',
          { class: 'hint' },
          ui.detected ? h('strong', { text: `Detected a ${view.providers[ui.detected].name} key. ` }) : null,
          'Stored only in this browser and sent only to ',
          p.name,
          '. Verifying sends one tiny test request. ',
          h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: `Get a ${p.name} key` }),
        ),
      ),
      resultSlot,
      h('p', { class: 'hint tip', text: 'Tip: create a separate key just for ContextPort and give it a monthly spending limit in your provider’s dashboard.' }),
      saved
        ? h(
            'div',
            {},
            h('button', {
              class: 'btn small danger',
              text: `Remove ${p.name} key`,
              onclick: async () => {
                view = { ...view, ...(await send({ type: 'SAVE_KEY', provider, key: '' })) };
                if (view.settings.engine === 'byok' && view.settings.provider === provider) {
                  await saveSettings({ engine: 'hosted' });
                  ui.engine = 'hosted';
                  renderEngines();
                }
                ui.result = null;
                flash('Key removed');
                renderByok();
              },
            }),
          )
        : null,
    ),
  );
}

async function runVerify() {
  if (ui.busy) return;
  const provider = ui.provider;
  const p = view.providers[provider];
  if (!ui.model) return;
  if (!ui.keyDraft && !view.keys[provider]) return;
  // Must be the first await inside the click so Chrome shows its permission prompt.
  const granted = await chrome.permissions.request({ origins: [p.origin] }).catch(() => false);
  if (!granted) {
    ui.result = { ok: false, stage: 'key', message: `ContextPort needs permission to contact ${p.name} to use your key.` };
    renderByok();
    return;
  }
  ui.busy = true;
  ui.result = null;
  renderByok();
  const r = await send({ type: 'VERIFY', provider, key: ui.keyDraft || null, model: ui.model }).catch((err) => ({ ok: false, stage: 'request', message: err.message }));
  if (r.models?.length) view.modelLists = { ...(view.modelLists || {}), [provider]: r.models };
  if (r.ok) {
    if (ui.keyDraft) view = { ...view, ...(await send({ type: 'SAVE_KEY', provider, key: ui.keyDraft })) };
    await saveSettings({ engine: 'byok', provider, models: { [provider]: ui.model } }, 'Key verified and saved');
    ui.keyDraft = '';
    ui.detected = null;
    ui.engine = 'byok';
    renderEngines();
  }
  ui.busy = false;
  ui.result = r;
  renderByok();
}

/* ── preferences & privacy ──────────────────────────────────────────── */

function setting(title, desc, control) {
  return h('div', { class: 'setting' }, h('div', {}, h('h3', { text: title }), h('p', { text: desc })), control);
}

function toggle(key, label) {
  const sw = h('button', {
    class: 'switch',
    role: 'switch',
    'aria-checked': String(!!view.settings[key]),
    'aria-label': label,
    onclick: async () => {
      await saveSettings({ [key]: !view.settings[key] }, 'Saved');
      sw.setAttribute('aria-checked', String(!!view.settings[key]));
    },
  });
  return sw;
}

function preferences() {
  const s = view.settings;
  return h(
    'div',
    { class: 'card settings-list' },
    setting(
      'Default destination',
      'Pre-selected when you open the Transfer panel.',
      h(
        'select',
        { class: 'select', 'aria-label': 'Default destination', onchange: (e) => saveSettings({ defaultDestination: e.target.value }, 'Saved') },
        h('option', { value: '', text: 'Automatic', selected: !s.defaultDestination }),
        Object.values(PLATFORMS).map((pl) => h('option', { value: pl.id, text: pl.name, selected: pl.id === s.defaultDestination })),
      ),
    ),
    setting(
      'Default format',
      'Smart brief is shorter and clearer; full transcript sends every message.',
      h(
        'select',
        { class: 'select', 'aria-label': 'Default format', onchange: (e) => saveSettings({ defaultMode: e.target.value }, 'Saved') },
        h('option', { value: 'smart', text: 'Smart brief', selected: s.defaultMode === 'smart' }),
        h('option', { value: 'full', text: 'Full transcript', selected: s.defaultMode === 'full' }),
      ),
    ),
    setting(
      'Brief length',
      'Short keeps just the essentials; Detailed captures everything.',
      h(
        'select',
        { class: 'select', 'aria-label': 'Brief length', onchange: (e) => saveSettings({ detail: e.target.value }, 'Saved') },
        [['short', 'Short'], ['standard', 'Standard'], ['detailed', 'Detailed']].map(([v, t]) => h('option', { value: v, text: t, selected: s.detail === v })),
      ),
    ),
    setting('Floating Transfer button', 'Shows a small button on chat pages. You can always use the toolbar icon or Alt+Shift+T.', toggle('showLauncher', 'Floating Transfer button')),
    setting('Limit & long-chat alerts', 'Offer to continue elsewhere when you hit a usage limit, or when a chat gets very long.', toggle('detectLimits', 'Limit and long-chat alerts')),
  );
}

/* ── About me & snippets ────────────────────────────────────────────── */

let personal = { aboutMe: '', snippets: [] };

function aboutSection() {
  const ta = h('textarea', {
    class: 'textarea',
    id: 'about-me',
    rows: '6',
    maxlength: '3000',
    placeholder: 'e.g. I’m a backend engineer at a fintech startup. We use TypeScript, Node 22, Postgres and AWS. I prefer concise answers with code first, and British spelling.',
    'aria-label': 'About me',
  });
  ta.value = personal.aboutMe;
  const count = h('span', { class: 'hint', text: `${ta.value.length}/3000` });
  ta.addEventListener('input', () => (count.textContent = `${ta.value.length}/3000`));
  return h(
    'div',
    { class: 'card pad' },
    ta,
    h('div', { class: 'row-between' }, count, h('button', {
      class: 'btn primary small',
      text: 'Save card',
      onclick: async () => {
        personal = await send({ type: 'SAVE_PERSONAL', aboutMe: ta.value });
        flash('About me saved');
      },
    })),
    setting('Add to every transfer', 'Include this card in briefs automatically. You can also toggle it per transfer, or insert it from the Transfer button’s menu.', toggle('includeAboutMe', 'Add About me to every transfer')),
  );
}

function snippetsSection() {
  const list = h('div', { class: 'snippets' });
  const draw = () => {
    list.replaceChildren(
      ...personal.snippets.map((sn, i) => {
        const name = h('input', { class: 'input', value: sn.name, maxlength: '60', 'aria-label': 'Snippet name' });
        const text = h('textarea', { class: 'textarea', rows: '3', maxlength: '5000', 'aria-label': 'Snippet text' });
        text.value = sn.text;
        return h(
          'div',
          { class: 'snippet' },
          h('div', { class: 'row-between' }, name, h('button', {
            class: 'btn small danger',
            text: 'Delete',
            onclick: async () => {
              personal.snippets.splice(i, 1);
              personal = await send({ type: 'SAVE_PERSONAL', snippets: personal.snippets });
              draw();
              flash('Snippet deleted');
            },
          })),
          text,
          h('button', {
            class: 'btn small',
            text: 'Save',
            onclick: async () => {
              personal.snippets[i] = { ...sn, name: name.value, text: text.value };
              personal = await send({ type: 'SAVE_PERSONAL', snippets: personal.snippets });
              draw();
              flash('Snippet saved');
            },
          }),
        );
      }),
    );
  };
  draw();
  return h(
    'div',
    {},
    h('div', { class: 'card pad' }, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Type ', h('kbd', { text: '//' }), ' in any ChatGPT, Claude or Gemini message box to insert a snippet, or press ', h('kbd', { text: 'Alt+Shift+S' }), '.'), list),
    h('button', {
      class: 'btn small',
      style: { marginTop: '10px' },
      onclick: async () => {
        personal.snippets.push({ id: crypto.randomUUID(), name: 'New snippet', text: 'Write your reusable prompt here.' });
        personal = await send({ type: 'SAVE_PERSONAL', snippets: personal.snippets });
        draw();
      },
    }, icon('plus'), 'Add snippet'),
  );
}

/* ── invites ────────────────────────────────────────────────────────── */

function inviteSection() {
  const box = h('div', { class: 'card pad invite-card' }, h('div', { class: 'hint', text: 'Loading your invite code…' }));
  send({ type: 'REFERRAL' })
    .then((r) => {
      const inviteText = `I use ContextPort to move AI chats between ChatGPT, Claude and Gemini without starting over. Install it with my invite code ${r.code} and we both get +${r.bonusPerReferral} free transfers a day: ${API_BASE}/install?ref=${r.code}`;
      const redeemInput = h('input', { class: 'input mono', placeholder: 'ABCD-EFGH', maxlength: '9', 'aria-label': 'Invite code' });
      const status = h('div', { role: 'status' });
      box.replaceChildren(
        h('div', { class: 'invite-code' }, h('div', {}, h('div', { class: 'eyebrow', text: 'Your invite code' }), h('div', { class: 'code', text: r.code })), h('button', {
          class: 'btn primary small',
          onclick: async (e) => {
            await navigator.clipboard.writeText(inviteText);
            e.currentTarget.replaceChildren(icon('check'), 'Invite copied');
          },
        }, icon('copy'), 'Copy invite')),
        h('p', { class: 'hint', text: `Each friend who installs and enters your code gives you both +${r.bonusPerReferral} free ContextPort AI transfers every day (up to ${r.maxReferrals} friends). ${r.credited ? `So far: ${r.credited} friend${r.credited === 1 ? '' : 's'}, +${r.bonusDaily}/day.` : ''}` }),
        r.redeemed
          ? h('div', { class: 'notice ok' }, icon('check'), 'You’ve used a friend’s invite code.')
          : h(
              'div',
              {},
              h('label', { class: 'field-label', text: 'Got a code from a friend?' }),
              h('div', { class: 'key-row' }, redeemInput, h('button', {
                class: 'btn small',
                text: 'Redeem',
                onclick: async () => {
                  try {
                    await send({ type: 'REDEEM_REFERRAL', code: redeemInput.value });
                    status.replaceChildren(h('div', { class: 'notice ok' }, icon('check'), `Done — you now get +${r.bonusPerReferral} free transfers a day.`));
                  } catch (err) {
                    status.replaceChildren(h('div', { class: 'notice error', text: err.message }));
                  }
                },
              })),
              status,
            ),
      );
    })
    .catch(() => box.replaceChildren(h('div', { class: 'notice', text: 'Invites need a connection to ContextPort. Try again later.' })));
  return box;
}

/* ── welcome ────────────────────────────────────────────────────────── */

const SAMPLE = [
  { role: 'user', content: 'Plan a 3-day trip to Lisbon for two in May. Budget €900 total excluding flights. We love food and viewpoints, hate crowds, and one of us is vegetarian.' },
  { role: 'assistant', content: 'Day 1: Alfama & Graça — Miradouro da Senhora do Monte at sunrise (quiet), lunch at a tasca with vegetarian options, Feira da Ladra on Tuesday. Day 2: Belém early (before 9am to avoid queues), then LX Factory. Day 3: Sintra by train on a weekday; skip Pena at midday. Budget: ~€110/night stay in Graça, ~€60/day food, €40 transport passes.' },
  { role: 'user', content: 'Great. We decided on the Graça apartment. Can you now find vegetarian-friendly dinner spots near Graça, and should we move Sintra to day 2 because rain is forecast on day 3?' },
];

function welcomeSection() {
  const pinBox = h('div', { class: 'pin-box' });
  send({ type: 'PIN_STATUS' })
    .then(({ pinned }) => {
      if (pinned) pinBox.replaceChildren(h('div', { class: 'notice ok' }, icon('check'), 'ContextPort is pinned to your toolbar.'));
      else
        pinBox.replaceChildren(
          h(
            'div',
            { class: 'pin' },
            h('div', { class: 'pin-art', 'aria-hidden': 'true' }, h('span', { class: 'puzzle', text: '🧩' }), icon('arrow'), h('img', { src: '../icons/icon32.png', alt: '' }), icon('pin')),
            h('div', {}, h('strong', { text: 'Pin ContextPort for one-click access' }), h('p', { class: 'hint', style: { margin: '2px 0 0' }, text: 'Click the puzzle icon in Chrome’s toolbar, then the pin next to ContextPort.' })),
          ),
        );
    })
    .catch(() => {});

  const demoOut = h('div', { class: 'demo-out' });
  const tryBtn = h('button', {
    class: 'btn primary',
    onclick: async () => {
      tryBtn.disabled = true;
      tryBtn.replaceChildren(h('span', { class: 'spin' }), 'Writing the brief…');
      try {
        const packet = await send({ type: 'PREPARE', sourcePlatform: 'chatgpt', payload: { messages: SAMPLE, title: 'Lisbon trip', url: '', mode: 'smart' } });
        demoOut.replaceChildren(
          h(
            'div',
            { class: 'card pad' },
            packet.notice ? h('div', { class: 'notice' }, icon('info'), packet.notice) : null,
            h('div', { class: 'hint', style: { marginTop: 0 }, text: `Written by ${packet.processorLabel}. This is what the next AI would receive:` }),
            renderBrief(packet),
          ),
        );
        send({ type: 'TRACK', name: 'onboarding_demo' }).catch(() => {});
        tryBtn.replaceChildren(icon('check'), 'That’s it — now try it on a real chat');
      } catch (err) {
        demoOut.replaceChildren(h('div', { class: 'notice error', text: err.message }));
        tryBtn.disabled = false;
        tryBtn.replaceChildren('Try again');
      }
    },
  }, icon('transfer'), 'Try a sample transfer');

  return h(
    'div',
    { class: 'welcome' },
    pinBox,
    h('strong', { text: 'See it work in 5 seconds' }),
    h('div', { class: 'sample' }, SAMPLE.map((m) => h('div', { class: `bubble ${m.role === 'user' ? 'u' : 'a'}`, text: m.content }))),
    tryBtn,
    demoOut,
    h('strong', { text: 'Then on a real chat' }),
    h(
      'ol',
      {},
      h('li', { text: 'Open a chat in ChatGPT, Claude or Gemini.' }),
      h('li', { text: 'Click Transfer at the bottom-right (or press Alt+Shift+T). On a new, empty chat it lets you bring in a saved brief instead.' }),
      h('li', { text: 'Pick where to continue, review the brief, and press Open.' }),
    ),
    h('div', { class: 'sites' }, ['chatgpt', 'claude', 'gemini'].map((id) => h('a', { class: 'btn small', href: PLATFORMS[id].newChatUrl, target: '_blank', rel: 'noopener', text: `Open ${PLATFORMS[id].name}` }))),
  );
}

function whatsNewSection() {
  return h('div', { class: 'card pad' }, h('div', { class: 'badge', text: `Version ${WHATS_NEW.version}` }), h('h3', { class: 'wn-title', text: WHATS_NEW.title }), h('ul', { class: 'wn-list' }, WHATS_NEW.items.map((t) => h('li', { text: t }))));
}

function privacy() {
  return h(
    'div',
    { class: 'card privacy' },
    h(
      'ul',
      {},
      h('li', { text: 'Your transfer history stays on this device. ContextPort has no account and no cloud copy of your chats.' }),
      h('li', { text: 'ContextPort AI reads the conversation only to write the brief, and does not store it. Only anonymous usage counts are kept.' }),
      h('li', { text: 'With your own key, the conversation goes directly from your browser to your chosen provider. Your key is never sent to ContextPort.' }),
      h('li', { text: 'Offline mode never sends your conversation anywhere except the AI you transfer it to.' }),
      h('li', { text: 'Nothing is ever sent automatically — you always review the context and press send yourself.' }),
      h('li', { text: 'Share links are end-to-end encrypted: the key is in the link itself and never reaches our server. Links expire after 7 days and can be revoked in the Library.' }),
    ),
    setting('Share anonymous usage statistics', 'Counts like “a transfer happened” and which AI it went to — never your conversations, titles or links. Helps us improve ContextPort.', toggle('shareStats', 'Share anonymous usage statistics')),
    h(
      'div',
      { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px' } },
      h('button', {
        class: 'btn small',
        text: 'Export history (JSON)',
        onclick: async () => {
          const data = await send({ type: 'EXPORT_HISTORY' });
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
          const a = h('a', { href: url, download: `contextport-history-${new Date().toISOString().slice(0, 10)}.json` });
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        },
      }),
      h('button', {
        class: 'btn small danger',
        text: 'Delete all history',
        onclick: async () => {
          if (!confirm('Delete every saved transfer on this device? This cannot be undone.')) return;
          await send({ type: 'CLEAR_HISTORY' });
          flash('History deleted');
        },
      }),
    ),
  );
}

/* ── page ───────────────────────────────────────────────────────────── */

function renderPage() {
  const welcome = location.hash === '#welcome';
  app.replaceChildren(
    h(
      'header',
      { class: 'hero' },
      h('div', { class: 'orb' }),
      h('div', { class: 'eyebrow', style: { position: 'relative' }, text: welcome ? 'Welcome to ContextPort' : 'Settings' }),
      h('h1', { class: 'display', text: welcome ? 'Move any AI chat, without starting over' : 'ContextPort settings' }),
      h('p', { text: 'ContextPort reads your conversation, writes a clear brief — goal, decisions, where you left off, and the exact code — and opens it in the AI you choose.' }),
      welcome ? welcomeSection() : null,
    ),
    h('nav', { class: 'toc', 'aria-label': 'Settings sections' }, [['engine', 'AI engine'], ['transfers', 'Transfers'], ['about', 'About me'], ['snippets', 'Snippets'], ['invite', 'Invite friends'], ['privacy', 'Privacy'], ['whats-new', 'What’s new']].map(([id, t]) => h('a', { href: `#${id}`, text: t }))),
    h('section', { class: 'block', id: 'engine' }, h('h2', { class: 'display', text: 'AI engine' }), h('p', { text: 'Choose what writes your brief. You can change this any time.' }), enginesSlot, byokSlot),
    h('section', { class: 'block', id: 'transfers' }, h('h2', { class: 'display', text: 'Transfers' }), h('p', { text: 'Defaults for the Transfer panel.' }), preferences()),
    h('section', { class: 'block', id: 'about' }, h('h2', { class: 'display', text: 'About me' }), h('p', { text: 'A short card about you and your preferences, so every AI knows your context without you repeating it.' }), aboutSection()),
    h('section', { class: 'block', id: 'snippets' }, h('h2', { class: 'display', text: 'Snippets' }), h('p', { text: 'Reusable prompts you can drop into any chat.' }), snippetsSection()),
    h('section', { class: 'block', id: 'invite' }, h('h2', { class: 'display', text: 'Invite friends' }), h('p', { text: 'Share ContextPort and get more free transfers.' }), inviteSection()),
    h('section', { class: 'block', id: 'privacy' }, h('h2', { class: 'display', text: 'Privacy & data' }), h('p', { text: 'What happens to your conversations.' }), privacy()),
    h('section', { class: 'block', id: 'whats-new' }, h('h2', { class: 'display', text: 'What’s new' }), whatsNewSection()),
  );
  renderEngines();
  renderByok();
  const target = location.hash.slice(1);
  if (target && target !== 'welcome') requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }));
}

async function init() {
  [view, personal] = await Promise.all([send({ type: 'GET_SETTINGS' }), send({ type: 'GET_PERSONAL' })]);
  ui.engine = view.settings.engine;
  ui.provider = view.settings.provider;
  ui.model = savedModel(ui.provider) || view.providers[ui.provider].examples[0];
  renderPage();
  if (view.settings.engine === 'hosted') {
    ui.usage = await send({ type: 'GET_USAGE' }).catch(() => null);
    renderEngines(); // updates only the engine cards; open controls stay open
  }
}

init().catch((err) => app.replaceChildren(h('div', { class: 'notice error', text: err.message })));
