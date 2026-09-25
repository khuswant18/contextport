/**
 * Builds a transfer packet using the engine the user chose:
 * ContextPort AI (hosted), their own API key, or fully offline.
 * Falls back to the offline brief with a clear notice instead of failing.
 */

import { API_BASE } from '../config.js';
import { createBrief, createOfflineBrief, prepare } from '../../../shared/pipeline.js';
import { PROVIDERS, providerComplete } from './providers.js';
import { getSecret, setSecret, getSettings } from './store.js';

class EngineError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function deviceToken(forceNew = false) {
  let token = forceNew ? null : await getSecret('deviceToken');
  if (token) return token;
  let res;
  try {
    res = await fetch(`${API_BASE}/api/v1/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw networkError(err);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.token) throw new EngineError(j.error || 'Could not connect to ContextPort AI.', 'hosted_unavailable');
  token = j.token;
  await setSecret('deviceToken', token);
  return token;
}

/** Turns a failed fetch into a message that names the real cause. */
function networkError(err) {
  if (err instanceof EngineError) return err;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return new EngineError('You appear to be offline.', 'offline');
  }
  if (err?.name === 'TimeoutError') {
    return new EngineError('ContextPort AI took too long to answer.', 'hosted_timeout');
  }
  // The internet works (the AI site loaded), so it's our service that is down.
  return new EngineError('ContextPort AI’s server isn’t responding right now.', 'hosted_unavailable');
}

async function hostedBrief(payload, retried = false, attempt = 0) {
  let res;
  try {
    const token = await deviceToken();
    res = await fetch(`${API_BASE}/api/v1/brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(75_000),
    });
  } catch (err) {
    const e = networkError(err);
    // One quick retry covers brief network blips and server restarts.
    if (e.code === 'hosted_unavailable' && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return hostedBrief(payload, retried, 1);
    }
    throw e;
  }
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && !retried) {
    await setSecret('deviceToken', null);
    return hostedBrief(payload, true);
  }
  if (!res.ok) throw new EngineError(j.error || `ContextPort AI error (${res.status}).`, j.code || 'hosted_error');
  if (j.usage) await chrome.storage.local.set({ usage: { ...j.usage, at: Date.now() } });
  return j;
}

export async function getHostedUsage() {
  const cached = (await chrome.storage.local.get('usage')).usage;
  const token = await getSecret('deviceToken');
  if (!token) return cached || null;
  try {
    const res = await fetch(`${API_BASE}/api/v1/usage`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return cached || null;
    const usage = await res.json();
    await chrome.storage.local.set({ usage: { ...usage, at: Date.now() } });
    return usage;
  } catch {
    return cached || null;
  }
}

function engineLabel(settings) {
  if (settings.engine === 'byok') {
    const p = PROVIDERS[settings.provider];
    return `Your ${p?.name || 'API'} key`;
  }
  if (settings.engine === 'offline') return 'Offline summary';
  return 'ContextPort AI';
}

/**
 * @param {{messages: Array, sourcePlatform: string, title: string, url: string, mode: 'smart'|'full'}} req
 */
export async function buildPacket(req) {
  const settings = await getSettings();
  const detail = ['short', 'standard', 'detailed'].includes(req.detail) ? req.detail : settings.detail || 'standard';
  const base = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    detail,
    mode: req.mode === 'full' ? 'full' : 'smart',
    source: { platform: req.sourcePlatform, title: String(req.title || '').slice(0, 300), url: String(req.url || '').slice(0, 2000) },
  };

  if (base.mode === 'full') {
    const { clean, blocks } = prepare(req.messages);
    return {
      ...base,
      messages: clean,
      brief: null,
      code: [],
      stats: { messages: clean.length, codeBlocks: blocks.length },
      processor: 'none',
      processorLabel: 'Full transcript',
    };
  }

  const offline = (notice) => ({
    ...base,
    ...createOfflineBrief({ messages: req.messages, title: base.source.title }),
    processor: 'offline',
    processorLabel: 'Offline summary',
    notice,
  });

  if (settings.engine === 'offline') return offline(null);

  try {
    if (settings.engine === 'byok') {
      const p = PROVIDERS[settings.provider];
      const key = await getSecret(`key:${settings.provider}`);
      if (!p || !key) throw new EngineError('No API key saved. Add one in Settings.', 'byok_missing');
      const model = settings.models?.[settings.provider] || p.examples[0];
      const result = await createBrief({
        messages: req.messages,
        sourcePlatform: req.sourcePlatform,
        title: base.source.title,
        budgetTokens: p.budgetTokens,
        detail,
        callModel: (prompt) => providerComplete(settings.provider, key, model, prompt),
      });
      return { ...base, ...result, processor: 'byok', processorLabel: `${engineLabel(settings)} · ${model}` };
    }

    const result = await hostedBrief({ messages: req.messages.map(({ role, content }) => ({ role, content })), sourcePlatform: req.sourcePlatform, title: base.source.title, detail });
    return {
      ...base,
      brief: result.brief,
      code: result.code,
      stats: result.stats,
      usage: result.usage,
      processor: 'hosted',
      processorLabel: 'ContextPort AI',
    };
  } catch (err) {
    if (err.name === 'InputError') throw err;
    const reason = err.message || 'The AI engine failed.';
    return offline(`${reason} Showing a basic offline summary instead.`);
  }
}

export { engineLabel };
