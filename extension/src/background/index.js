/**
 * ContextPort service worker: message router, transfer orchestration and
 * destination hand-off.
 *
 * Security model:
 * - Only this extension can message the worker (no externally_connectable).
 * - Content scripts get a narrow API (prepare, hand off, claim their own
 *   pending insert). Settings, keys and history are only reachable from the
 *   extension's own pages.
 * - API keys are never returned to any page; the options page sees a masked hint.
 */

import { PLATFORMS, DETAIL_LEVELS } from '../../../shared/constants.js';
import { formatHandoff } from '../../../shared/format.js';
import { buildPacket, getHostedUsage, engineLabel } from './engine.js';
import { track, flush, clearQueue } from './telemetry.js';
import { createShareLink, revokeShareLink, getReferral, redeemReferral, sendFeedback } from './share.js';
import { PROVIDERS, verify, detectProvider, MODEL_ID_RE } from './providers.js';
import {
  getSettings,
  saveSettings,
  getSecret,
  setSecret,
  saveTransfer,
  updateTransfer,
  getTransfer,
  listTransfers,
  deleteTransfer,
  clearTransfers,
  listProjects,
  putProject,
  getProject,
  removeProject,
  getPersonal,
  savePersonal,
  getStats,
  bumpStats,
} from './store.js';

const SEEN_KEYS = ['tip_launcher', 'tip_snippets', 'pin_prompt'];
const STORE_REVIEW_URL = () => `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;

const SUPPORTED_HOSTS = {
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'claude.ai': 'claude',
  'gemini.google.com': 'gemini',
  'www.perplexity.ai': 'perplexity',
  'perplexity.ai': 'perplexity',
};

const PENDING_TTL_MS = 10 * 60_000;
const MAX_TEXT_CHARS = 400_000;

function platformOfUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? SUPPORTED_HOSTS[u.hostname] || null : null;
  } catch {
    return null;
  }
}

function senderKind(sender) {
  if (sender.id !== chrome.runtime.id) return null;
  // Extension pages (popup, side panel, options) are served from our own origin;
  // content scripts report the URL of the web page they run in.
  if (sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return 'extension';
  if (sender.tab && platformOfUrl(sender.url || sender.tab.url)) return 'content';
  return null;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (chrome.sidePanel?.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  if (details.reason === 'install') {
    track('install');
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#welcome') });
  } else if (details.reason === 'update') {
    track('update');
    await chrome.storage.local.set({ whatsNew: { version: chrome.runtime.getManifest().version, seen: false } });
  }
});
chrome.runtime.onStartup?.addListener(() => flush());

chrome.commands?.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !platformOfUrl(tab.url)) return;
  if (command === 'open-transfer') chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL', trigger: 'shortcut' }).catch(() => {});
  if (command === 'open-snippets') chrome.tabs.sendMessage(tab.id, { type: 'OPEN_SNIPPETS' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const kind = senderKind(sender);
  if (!kind || !msg || typeof msg.type !== 'string') return false;
  route(msg, sender, kind)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.warn('[ContextPort]', msg.type, err?.message);
      sendResponse({ ok: false, error: err?.message || 'Something went wrong' });
    });
  return true;
});

async function route(msg, sender, kind) {
  /* ── available to content scripts and extension pages ─────────────── */
  switch (msg.type) {
    case 'PREPARE': {
      const sourcePlatform = kind === 'content' ? platformOfUrl(sender.url || sender.tab.url) : msg.sourcePlatform;
      if (!PLATFORMS[sourcePlatform]) throw new Error('Unsupported source');
      return buildPacket({ ...msg.payload, sourcePlatform });
    }
    case 'FORMAT':
      return formatHandoff(msg.packet, msg.destination);
    case 'HANDOFF':
      return handoff(msg.payload, sender);
    case 'CLAIM_PENDING':
      if (kind !== 'content') throw new Error('Forbidden');
      return claimPending(sender);
    case 'HAS_PENDING': {
      if (kind !== 'content') throw new Error('Forbidden');
      const pending = (await chrome.storage.session.get('pending')).pending || {};
      const e = pending[sender.tab?.id];
      return !!(e && e.expires > Date.now());
    }
    case 'REPORT':
      if (kind !== 'content') throw new Error('Forbidden');
      if (typeof msg.handoffId === 'string') await updateTransfer(msg.handoffId, { status: String(msg.status).slice(0, 40) });
      if (msg.status === 'delivered' || msg.status === 'inserted') {
        await bumpStats((x) => (x.delivered += 1));
        track('delivered', { destination: platformOfUrl(sender.url || sender.tab?.url) });
      } else if (msg.status === 'failed') {
        track('delivery_failed', { destination: platformOfUrl(sender.url || sender.tab?.url) });
      }
      return null;
    case 'UI_SETTINGS': {
      const s = await getSettings();
      const { seen = {} } = await chrome.storage.local.get('seen');
      const { aboutMe } = await getPersonal();
      return {
        showLauncher: s.showLauncher,
        defaultDestination: s.defaultDestination,
        defaultMode: s.defaultMode,
        detail: s.detail,
        includeAboutMe: s.includeAboutMe,
        hasAboutMe: !!aboutMe.trim(),
        detectLimits: s.detectLimits,
        engineLabel: engineLabel(s),
        engine: s.engine,
        seen,
      };
    }
    case 'GET_PERSONAL':
      return getPersonal();
    case 'TRACK':
      await track(String(msg.name), msg.props && typeof msg.props === 'object' ? msg.props : {});
      return null;
    case 'MARK_SEEN': {
      if (!SEEN_KEYS.includes(msg.key)) throw new Error('Unknown key');
      const { seen = {} } = await chrome.storage.local.get('seen');
      seen[msg.key] = Date.now();
      await chrome.storage.local.set({ seen });
      return null;
    }
    case 'NUDGE_CHECK':
      return nudgeCheck(String(msg.kind), String(msg.key || ''), sender);
    case 'REVIEW_CHECK': {
      if (kind !== 'content') throw new Error('Forbidden');
      const st = await getStats();
      if (st.delivered < 3 || st.reviewAsked) return null;
      await bumpStats((x) => (x.reviewAsked = true));
      return { url: STORE_REVIEW_URL() };
    }
    case 'FEEDBACK': {
      const body = {
        rating: msg.rating === 1 ? 1 : -1,
        reasons: Array.isArray(msg.reasons) ? msg.reasons.slice(0, 7).map(String) : [],
        processor: String(msg.processor || ''),
        mode: String(msg.mode || ''),
        detail: String(msg.detail || ''),
      };
      if (typeof msg.transferId === 'string') await updateTransfer(msg.transferId, { rating: body.rating }).catch(() => {});
      await sendFeedback(body).catch(() => {});
      track('feedback', { rating: body.rating === 1 ? 'up' : 'down' });
      return null;
    }
    case 'SAVE_CHECKPOINT':
      return saveCheckpoint(msg.packet, msg.projectId);
    case 'CREATE_SHARE':
      return share(msg);
    case 'OPEN_OPTIONS': {
      const section = ['about', 'snippets', 'engine', 'invite'].includes(msg.section) ? `#${msg.section}` : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html${section}`) });
      return null;
    }
    case 'OPEN_LIBRARY': {
      // The side panel needs a user gesture, which Chrome doesn't always carry
      // over from a page click; fall back to opening the Library in a tab.
      const opened = sender.tab?.windowId ? await chrome.sidePanel.open({ windowId: sender.tab.windowId }).then(() => true, () => false) : false;
      if (!opened) await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html'), index: sender.tab ? sender.tab.index + 1 : undefined });
      return null;
    }
    case 'RECENT_BRIEFS':
      // Titles only; the text is fetched for one item when the user picks it.
      return (await listTransfers(12))
        .filter((t) => t.packet?.source)
        .slice(0, 6)
        .map((t) => ({ id: t.id, title: summaryOf(t).title, source: t.packet.source.platform, createdAt: t.createdAt }));
    case 'BRIEF_TEXT': {
      const t = await getTransfer(String(msg.id));
      if (!t?.packet?.source) throw new Error('That brief is no longer in your Library.');
      const destination = kind === 'content' ? platformOfUrl(sender.url || sender.tab?.url) : msg.destination;
      if (!PLATFORMS[destination]) throw new Error('Unsupported destination');
      track('library_insert', { source: t.packet.source.platform, destination });
      return t.destination === destination && t.kind !== 'checkpoint' ? t.text : formatHandoff(t.packet, destination, { aboutMe: await aboutMeIfEnabled() });
    }
    case 'LIST_PROJECTS':
      return (await listProjects()).map(({ id, name, updatedAt }) => ({ id, name, updatedAt }));
    case 'CREATE_PROJECT':
      return createProject(msg.name);
  }

  /* ── extension pages only ──────────────────────────────────────────── */
  if (kind !== 'extension') throw new Error('Forbidden');
  switch (msg.type) {
    case 'GET_SETTINGS':
      return settingsView();
    case 'SAVE_SETTINGS':
      return saveSettingsFromPage(msg.patch || {});
    case 'SAVE_KEY':
      return saveKey(msg.provider, msg.key);
    case 'VERIFY':
      return verifyKey(msg.provider, msg.key, msg.model);
    case 'DETECT_PROVIDER':
      return detectProvider(msg.key);
    case 'GET_USAGE':
      return getHostedUsage();
    case 'LIST_HISTORY':
      return (await listTransfers(Math.min(Number(msg.limit) || 100, 200))).map(summaryOf);
    case 'GET_TRANSFER':
      return getTransfer(String(msg.id));
    case 'DELETE_TRANSFER':
      return deleteTransfer(String(msg.id));
    case 'CLEAR_HISTORY':
      return clearTransfers();
    case 'EXPORT_HISTORY':
      return listTransfers(200);
    case 'RESEND':
      track('resume', { destination: msg.destination, trigger: 'library' });
      return resend(String(msg.id), msg.destination);
    case 'SAVE_PERSONAL':
      return savePersonalFromPage(msg);
    case 'GET_PROJECT':
      return projectView(String(msg.id));
    case 'RENAME_PROJECT':
      return renameProject(String(msg.id), msg.name);
    case 'DELETE_PROJECT':
      return deleteProject(String(msg.id));
    case 'SET_TRANSFER_PROJECT':
      return setTransferProject(String(msg.id), msg.projectId ? String(msg.projectId) : null);
    case 'RESEND_PROJECT':
      return resendProject(String(msg.id), msg.destination);
    case 'REVOKE_SHARE':
      return revokeShare(String(msg.id));
    case 'STATS':
      return statsView();
    case 'WHATS_NEW': {
      const { whatsNew } = await chrome.storage.local.get('whatsNew');
      return whatsNew && !whatsNew.seen ? whatsNew : null;
    }
    case 'DISMISS_WHATS_NEW': {
      const { whatsNew } = await chrome.storage.local.get('whatsNew');
      if (whatsNew) await chrome.storage.local.set({ whatsNew: { ...whatsNew, seen: true } });
      return null;
    }
    case 'REFERRAL':
      return getReferral();
    case 'REDEEM_REFERRAL': {
      const r = await redeemReferral(String(msg.code || ''));
      track('referral_redeemed');
      return r;
    }
    case 'PIN_STATUS': {
      const s = await chrome.action.getUserSettings?.().catch(() => null);
      return { pinned: s ? !!s.isOnToolbar : null };
    }
  }
  throw new Error('Unknown request');
}

function summaryOf(t) {
  return {
    id: t.id,
    createdAt: t.createdAt,
    source: t.packet?.source?.platform,
    destination: t.destination,
    title: t.packet?.brief?.title || t.packet?.source?.title || 'Conversation',
    goal: t.packet?.brief?.goal || '',
    // A hand-off whose tab was closed mid-insert never reports back; call it sent.
    status: ['opening', 'inserting'].includes(t.status) && Date.now() - t.createdAt > 3 * 60_000 ? 'sent' : t.status,
    processorLabel: t.packet?.processorLabel,
    mode: t.packet?.mode,
    kind: t.kind || 'handoff',
    projectId: t.projectId || null,
    shared: !!t.share,
  };
}

/* ── settings & keys ───────────────────────────────────────────────── */

async function settingsView() {
  const s = await getSettings();
  const keys = {};
  for (const id of Object.keys(PROVIDERS)) {
    const k = await getSecret(`key:${id}`);
    keys[id] = k ? `${k.slice(0, Math.min(6, k.length - 4))}…${k.slice(-4)}` : '';
  }
  const providers = Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, p]) => [id, { name: p.name, keyUrl: p.keyUrl, keyHint: p.keyHint, examples: p.examples, origin: p.origin }]),
  );
  const modelLists = (await chrome.storage.local.get('modelLists')).modelLists || {};
  return { settings: s, keys, providers, modelLists };
}

async function saveSettingsFromPage(patch) {
  const clean = {};
  if (['hosted', 'byok', 'offline'].includes(patch.engine)) clean.engine = patch.engine;
  if (PROVIDERS[patch.provider]) clean.provider = patch.provider;
  if (patch.models && typeof patch.models === 'object') {
    const current = (await getSettings()).models || {};
    clean.models = { ...current };
    for (const [k, v] of Object.entries(patch.models)) if (PROVIDERS[k] && typeof v === 'string' && MODEL_ID_RE.test(v)) clean.models[k] = v;
  }
  if (patch.defaultDestination === '' || PLATFORMS[patch.defaultDestination]) clean.defaultDestination = patch.defaultDestination;
  if (['smart', 'full'].includes(patch.defaultMode)) clean.defaultMode = patch.defaultMode;
  if (typeof patch.showLauncher === 'boolean') clean.showLauncher = patch.showLauncher;
  if (DETAIL_LEVELS.includes(patch.detail)) clean.detail = patch.detail;
  for (const k of ['includeAboutMe', 'shareStats', 'detectLimits']) if (typeof patch[k] === 'boolean') clean[k] = patch[k];
  if (clean.shareStats === false) await clearQueue();
  await saveSettings(clean);
  return settingsView();
}

function validKey(provider, key) {
  return PROVIDERS[provider] && typeof key === 'string' && key.length >= 16 && key.length <= 400 && /^[\x21-\x7e]+$/.test(key);
}

async function saveKey(provider, key) {
  if (!PROVIDERS[provider]) throw new Error('Unknown provider');
  if (key === '') {
    await setSecret(`key:${provider}`, null);
    return settingsView();
  }
  if (!validKey(provider, key)) throw new Error('That does not look like a valid API key.');
  await setSecret(`key:${provider}`, key.trim());
  return settingsView();
}

/**
 * Verifies key + model with one tiny real request. Returns a result object
 * (never throws) so the page can show which step failed and suggestions.
 */
async function verifyKey(provider, key, model) {
  if (!PROVIDERS[provider]) throw new Error('Unknown provider');
  const k = key ? String(key).trim() : await getSecret(`key:${provider}`);
  if (!k) return { ok: false, stage: 'key', message: 'Paste your API key first.' };
  if (!validKey(provider, k)) return { ok: false, stage: 'key', message: 'That does not look like a valid API key.' };
  try {
    const r = await verify(provider, k, String(model || '').trim());
    await rememberModels(provider, r.models);
    return { ok: true, ...r };
  } catch (err) {
    if (err.models?.length) await rememberModels(provider, err.models);
    return { ok: false, stage: err.stage || 'request', code: err.code, message: err.message, suggestions: err.suggestions || [], models: err.models || [] };
  }
}

async function rememberModels(provider, models) {
  const all = (await chrome.storage.local.get('modelLists')).modelLists || {};
  all[provider] = models.slice(0, 1000);
  await chrome.storage.local.set({ modelLists: all });
}

/* ── hand-off ──────────────────────────────────────────────────────── */

async function handoff(payload, sender) {
  const { packet, destination, text } = payload || {};
  const projectId = typeof payload?.projectId === 'string' ? payload.projectId : null;
  if (!PLATFORMS[destination]) throw new Error('Unsupported destination');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to send');
  if (text.length > MAX_TEXT_CHARS) throw new Error('The context is too long to insert');
  if (!packet || typeof packet.id !== 'string') throw new Error('Invalid transfer');

  const id = packet.id;
  const existing = await getTransfer(id);
  await saveTransfer({
    id,
    createdAt: existing?.createdAt || Date.now(),
    packet: stripForHistory(packet),
    destination,
    text,
    status: 'opening',
    kind: 'handoff',
    projectId: projectId || existing?.projectId || null,
  });
  if (projectId) await touchProject(projectId);
  await recordValue(text);
  const props = { source: packet.source?.platform, destination, mode: packet.mode, processor: packet.processor };
  if (payload?.trigger) props.trigger = payload.trigger;
  if (payload?.scope) props.scope = payload.scope;
  track('handoff', props);

  const url = PLATFORMS[destination].newChatUrl;
  const tab = await chrome.tabs.create({ url, index: sender?.tab ? sender.tab.index + 1 : undefined });
  const pending = (await chrome.storage.session.get('pending')).pending || {};
  // Drop expired entries.
  for (const [k, v] of Object.entries(pending)) if (v.expires < Date.now()) delete pending[k];
  pending[tab.id] = { handoffId: id, destination, text, expires: Date.now() + PENDING_TTL_MS };
  await chrome.storage.session.set({ pending });
  // A fast page may have finished checking before the entry existed; nudge it.
  chrome.tabs.sendMessage(tab.id, { type: 'PENDING_READY' }).catch(() => {});
  return { tabId: tab.id, handoffId: id };
}

function stripForHistory(packet) {
  // Keep what the library needs; bound size.
  const p = { ...packet };
  if (p.messages && JSON.stringify(p.messages).length > 300_000) p.messages = p.messages.slice(-60);
  return p;
}

async function claimPending(sender) {
  const tabId = sender.tab?.id;
  const platform = platformOfUrl(sender.url || sender.tab?.url);
  const pending = (await chrome.storage.session.get('pending')).pending || {};
  const entry = pending[tabId];
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    delete pending[tabId];
    await chrome.storage.session.set({ pending });
    return null;
  }
  // Only hand the text to the platform it was meant for (e.g. not a login redirect elsewhere).
  if (entry.destination !== platform) return null;
  delete pending[tabId];
  await chrome.storage.session.set({ pending });
  await updateTransfer(entry.handoffId, { status: 'inserting' });
  return { text: entry.text, handoffId: entry.handoffId };
}

async function aboutMeIfEnabled() {
  const s = await getSettings();
  if (!s.includeAboutMe) return '';
  return (await getPersonal()).aboutMe;
}

async function resend(id, destination) {
  const t = await getTransfer(id);
  if (!t) throw new Error('Transfer not found');
  if (!PLATFORMS[destination]) throw new Error('Unsupported destination');
  const text = t.destination === destination && t.kind !== 'checkpoint' ? t.text : formatHandoff(t.packet, destination, { aboutMe: await aboutMeIfEnabled() });
  const packet = { ...t.packet, id: crypto.randomUUID() };
  return handoff({ packet, destination, text, projectId: t.projectId }, null);
}

/* ── value & stats ─────────────────────────────────────────────────── */

/**
 * Rough time saved: what it would take to re-explain this by hand
 * (typing at ~40 wpm ≈ 4 chars/s) plus a minute of setup. Capped at 30 min.
 */
function secondsSavedFor(text) {
  return Math.min(1800, Math.round(60 + text.length / 4));
}

async function recordValue(text) {
  const month = new Date().toISOString().slice(0, 7);
  const secs = secondsSavedFor(text);
  await bumpStats((x) => {
    x.transfers += 1;
    x.secondsSaved += secs;
    const m = x.months[month] || { transfers: 0, secondsSaved: 0 };
    m.transfers += 1;
    m.secondsSaved += secs;
    x.months[month] = m;
    // Keep only the last 12 months.
    const keys = Object.keys(x.months).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 12))) delete x.months[k];
  });
}

async function statsView() {
  const s = await getStats();
  const month = new Date().toISOString().slice(0, 7);
  return { month: s.months[month] || { transfers: 0, secondsSaved: 0 }, lifetime: { transfers: s.transfers, secondsSaved: s.secondsSaved, delivered: s.delivered } };
}

/* ── nudges (limits, long chats) ───────────────────────────────────── */

async function nudgeCheck(kindName, key, sender) {
  if (!['limit', 'long_chat'].includes(kindName)) throw new Error('Unknown nudge');
  const s = await getSettings();
  if (!s.detectLimits) return false;
  const k = `${kindName}:${key.slice(0, 200) || sender.tab?.id}`;
  const { nudges = {} } = await chrome.storage.session.get('nudges');
  const cooldown = kindName === 'limit' ? 15 * 60_000 : 7 * 86_400_000;
  if (nudges[k] && Date.now() - nudges[k] < cooldown) return false;
  nudges[k] = Date.now();
  await chrome.storage.session.set({ nudges });
  track(kindName === 'limit' ? 'limit_detected' : 'long_chat_nudge', { source: platformOfUrl(sender.url || sender.tab?.url) });
  return true;
}

/* ── checkpoints, projects, sharing ────────────────────────────────── */

function validPacket(packet) {
  return packet && typeof packet.id === 'string' && packet.source && PLATFORMS[packet.source.platform];
}

async function saveCheckpoint(packet, projectId) {
  if (!validPacket(packet)) throw new Error('Invalid brief');
  const existing = await getTransfer(packet.id);
  await saveTransfer({
    id: packet.id,
    createdAt: existing?.createdAt || Date.now(),
    packet: stripForHistory(packet),
    destination: existing?.destination || null,
    text: existing?.text || formatHandoff(packet, 'chatgpt'),
    status: existing?.status || 'saved',
    kind: existing?.kind || 'checkpoint',
    projectId: typeof projectId === 'string' ? projectId : existing?.projectId || null,
  });
  if (typeof projectId === 'string') await touchProject(projectId);
  track('checkpoint_saved', { source: packet.source.platform });
  return { id: packet.id };
}

const cleanName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);

async function createProject(name) {
  const n = cleanName(name);
  if (!n) throw new Error('Give the project a name.');
  const project = { id: crypto.randomUUID(), name: n, createdAt: Date.now(), updatedAt: Date.now() };
  await putProject(project);
  return project;
}

async function touchProject(id) {
  const p = await getProject(id);
  if (p) await putProject({ ...p, updatedAt: Date.now() });
}

async function renameProject(id, name) {
  const p = await getProject(id);
  if (!p) throw new Error('Project not found');
  const n = cleanName(name);
  if (!n) throw new Error('Give the project a name.');
  await putProject({ ...p, name: n, updatedAt: Date.now() });
  return projectView(id);
}

async function deleteProject(id) {
  for (const t of await listTransfers(10_000)) if (t.projectId === id) await updateTransfer(t.id, { projectId: null });
  await removeProject(id);
  return null;
}

async function setTransferProject(id, projectId) {
  if (projectId && !(await getProject(projectId))) throw new Error('Project not found');
  await updateTransfer(id, { projectId });
  if (projectId) await touchProject(projectId);
  return null;
}

async function projectView(id) {
  const project = await getProject(id);
  if (!project) throw new Error('Project not found');
  const transfers = (await listTransfers(10_000)).filter((t) => t.projectId === id).map(summaryOf);
  return { project, transfers };
}

/** Latest brief of the project, plus a timeline of earlier milestones. */
async function resendProject(id, destination) {
  if (!PLATFORMS[destination]) throw new Error('Unsupported destination');
  const project = await getProject(id);
  if (!project) throw new Error('Project not found');
  const items = (await listTransfers(10_000)).filter((t) => t.projectId === id);
  if (!items.length) throw new Error('This project has no saved briefs yet.');
  const [latest, ...earlier] = items; // newest first
  let text = formatHandoff(latest.packet, destination, { aboutMe: await aboutMeIfEnabled() });
  if (earlier.length) {
    const lines = earlier
      .slice(0, 15)
      .reverse()
      .map((t) => `- ${new Date(t.createdAt).toISOString().slice(0, 10)} — ${t.packet?.brief?.title || t.packet?.source?.title || 'Session'}${t.packet?.brief?.goal ? `: ${t.packet.brief.goal}` : ''}`);
    text += `\n\n## Earlier in the "${project.name}" project\n${lines.join('\n')}`;
  }
  const packet = { ...latest.packet, id: crypto.randomUUID() };
  track('resume', { destination, trigger: 'library' });
  return handoff({ packet, destination, text, projectId: id }, null);
}

async function share(msg) {
  let packet = msg.packet;
  let transferId = typeof msg.id === 'string' ? msg.id : null;
  if (transferId) {
    const t = await getTransfer(transferId);
    if (!t) throw new Error('Transfer not found');
    if (t.share?.url && new Date(t.share.expiresAt) > new Date()) return t.share;
    packet = t.packet;
  }
  if (!validPacket(packet)) throw new Error('Nothing to share yet');
  const link = await createShareLink(packet, 7);
  if (!transferId) {
    await saveCheckpoint(packet, null);
    transferId = packet.id;
  }
  await updateTransfer(transferId, { share: link });
  track('share_created', { source: packet.source.platform });
  return link;
}

async function revokeShare(transferId) {
  const t = await getTransfer(transferId);
  if (!t?.share) return null;
  await revokeShareLink(t.share.id);
  await updateTransfer(transferId, { share: null });
  return null;
}

/* ── personal data ─────────────────────────────────────────────────── */

async function savePersonalFromPage(msg) {
  const patch = {};
  if (typeof msg.aboutMe === 'string') patch.aboutMe = msg.aboutMe.slice(0, 3000);
  if (Array.isArray(msg.snippets)) {
    patch.snippets = msg.snippets
      .slice(0, 50)
      .map((x) => ({ id: String(x.id || crypto.randomUUID()).slice(0, 60), name: cleanName(x.name).slice(0, 60), text: String(x.text || '').slice(0, 5000) }))
      .filter((x) => x.name && x.text.trim());
  }
  await savePersonal(patch);
  return getPersonal();
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const pending = (await chrome.storage.session.get('pending')).pending || {};
  if (pending[tabId]) {
    delete pending[tabId];
    await chrome.storage.session.set({ pending });
  }
});
