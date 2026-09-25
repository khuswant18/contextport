/**
 * Bring-your-own-key providers. Calls go straight from the extension to the
 * provider; the key never touches ContextPort's server.
 *
 * Users may type ANY model id. `verify` checks the key, looks the model up in
 * the provider's model list, and makes one tiny real request, so a typo,
 * a model the key can't access, or an account without credit is caught before
 * the first transfer.
 */

import Anthropic from '@anthropic-ai/sdk';

/** `examples` only pre-fill the model picker; any id the key can use works. */
export const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    keyPattern: /^sk-(?!ant-|or-)/,
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    origin: 'https://api.openai.com/*',
    base: 'https://api.openai.com/v1',
    kind: 'openai',
    tokenParam: 'max_completion_tokens',
    sendTemperature: false,
    examples: ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini', 'gpt-4o-mini'],
    modelFilter: (id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation)/.test(id),
    budgetTokens: 60_000,
  },
  anthropic: {
    name: 'Anthropic (Claude)',
    keyPattern: /^sk-ant-/,
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    origin: 'https://api.anthropic.com/*',
    kind: 'anthropic',
    examples: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    modelFilter: (id) => id.startsWith('claude-'),
    budgetTokens: 80_000,
  },
  gemini: {
    name: 'Google Gemini',
    keyPattern: /^AIza/,
    keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    origin: 'https://generativelanguage.googleapis.com/*',
    base: 'https://generativelanguage.googleapis.com/v1beta',
    kind: 'gemini',
    examples: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    modelFilter: (id) => id.startsWith('gemini-') && !/(embedding|image|tts|live|audio)/.test(id),
    budgetTokens: 80_000,
  },
  groq: {
    name: 'Groq',
    keyPattern: /^gsk_/,
    keyHint: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    origin: 'https://api.groq.com/*',
    base: 'https://api.groq.com/openai/v1',
    kind: 'openai',
    tokenParam: 'max_tokens',
    sendTemperature: true,
    examples: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
    modelFilter: (id) => !/(whisper|guard|orpheus|tts|safeguard)/.test(id),
    // Groq's free tier allows ~8k tokens/minute per model.
    budgetTokens: 4_500,
  },
  openrouter: {
    name: 'OpenRouter',
    keyPattern: /^sk-or-/,
    keyHint: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
    origin: 'https://openrouter.ai/*',
    base: 'https://openrouter.ai/api/v1',
    kind: 'openai',
    tokenParam: 'max_tokens',
    sendTemperature: true,
    examples: ['openai/gpt-5-mini', 'anthropic/claude-sonnet-5', 'google/gemini-2.5-flash'],
    modelFilter: () => true,
    budgetTokens: 60_000,
  },
  deepseek: {
    name: 'DeepSeek',
    keyPattern: null, // sk-… like OpenAI; choose manually
    keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    origin: 'https://api.deepseek.com/*',
    base: 'https://api.deepseek.com/v1',
    kind: 'openai',
    tokenParam: 'max_tokens',
    sendTemperature: true,
    examples: ['deepseek-chat', 'deepseek-reasoner'],
    modelFilter: () => true,
    budgetTokens: 50_000,
  },
  mistral: {
    name: 'Mistral',
    keyPattern: null,
    keyHint: 'your Mistral key',
    keyUrl: 'https://console.mistral.ai/api-keys',
    origin: 'https://api.mistral.ai/*',
    base: 'https://api.mistral.ai/v1',
    kind: 'openai',
    tokenParam: 'max_tokens',
    sendTemperature: true,
    examples: ['mistral-large-latest', 'mistral-small-latest'],
    modelFilter: (id) => !/(embed|moderation|ocr)/.test(id),
    budgetTokens: 50_000,
  },
  xai: {
    name: 'xAI (Grok)',
    keyPattern: /^xai-/,
    keyHint: 'xai-…',
    keyUrl: 'https://console.x.ai',
    origin: 'https://api.x.ai/*',
    base: 'https://api.x.ai/v1',
    kind: 'openai',
    tokenParam: 'max_tokens',
    sendTemperature: true,
    examples: ['grok-4', 'grok-3-mini'],
    modelFilter: (id) => !/(image|vision-only|embed)/.test(id),
    budgetTokens: 60_000,
  },
  together: {
    name: 'Together AI',
    keyPattern: /^tgp_/,
    keyHint: 'your Together key',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    origin: 'https://api.together.xyz/*',
    base: 'https://api.together.xyz/v1',
    kind: 'openai',
    tokenParam: 'max_tokens',
    sendTemperature: true,
    examples: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'],
    modelFilter: (id) => !/(embed|rerank|image|flux|whisper|tts)/i.test(id),
    budgetTokens: 50_000,
  },
};

/** Guesses the provider from a key's prefix (null when ambiguous). */
export function detectProvider(key) {
  const k = String(key || '').trim();
  for (const [id, p] of Object.entries(PROVIDERS)) if (p.keyPattern && p.keyPattern.test(k)) return id;
  return null;
}

export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/;

export class ProviderError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readError(res) {
  try {
    const j = await res.json();
    return String(j?.error?.message || j?.message || j?.error || '').slice(0, 240);
  } catch {
    return '';
  }
}

function friendly(status, detail, providerName, model) {
  // Never include the raw detail for auth errors: some providers echo part of the key.
  if (status === 401 || status === 403) return new ProviderError(`${providerName} rejected the API key.`, status, 'bad_key');
  if (status === 402 || /insufficient_quota|credit|billing|balance/i.test(detail)) {
    return new ProviderError(`${providerName} accepted the key but the account has no credit or quota left.`, status, 'no_credit');
  }
  if (status === 404 || /model.*(not.*found|does not exist|not available|invalid)/i.test(detail)) {
    return new ProviderError(`${providerName} doesn't offer "${model}" to this key.`, status, 'bad_model');
  }
  if (status === 429) return new ProviderError(`${providerName} rate limit reached. Try again shortly.`, 429, 'rate_limit');
  return new ProviderError(`${providerName} error ${status}${detail ? `: ${detail}` : ''}`, status, 'error');
}

const TIMEOUT = 90_000;
const OUTPUT_TOKENS = 6_000;

const JSON_UNSUPPORTED = /response_format|json_object|json mode|responseMimeType|response_mime_type/i;

async function openaiComplete(p, key, model, { system, user }, opts = {}) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    [p.tokenParam]: opts.maxTokens || OUTPUT_TOKENS,
  };
  if (!opts.plain) body.response_format = { type: 'json_object' };
  if (p.sendTemperature) body.temperature = 0.2;
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT),
  });
  if (!res.ok) {
    const detail = await readError(res);
    // Some models don't support JSON mode: retry once without it (the prompt still asks for JSON).
    if (res.status === 400 && !opts.plain && JSON_UNSUPPORTED.test(detail)) return openaiComplete(p, key, model, { system, user }, { ...opts, plain: true });
    throw friendly(res.status, detail, p.name, model);
  }
  const j = await res.json();
  return j?.choices?.[0]?.message?.content || '';
}

async function geminiComplete(p, key, model, { system, user }, opts = {}) {
  const generationConfig = { temperature: 0.2, maxOutputTokens: opts.maxTokens || OUTPUT_TOKENS };
  if (!opts.plain) generationConfig.responseMimeType = 'application/json';
  const res = await fetch(`${p.base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT),
  });
  if (!res.ok) {
    const detail = await readError(res);
    if (res.status === 400 && !opts.plain && JSON_UNSUPPORTED.test(detail)) return geminiComplete(p, key, model, { system, user }, { ...opts, plain: true });
    // Gemini reports bad keys as 400 API_KEY_INVALID.
    if (/API_KEY_INVALID|API key not valid/i.test(detail)) throw friendly(401, '', p.name, model);
    throw friendly(res.status, detail, p.name, model);
  }
  const j = await res.json();
  return (j?.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
}

function anthropicClient(key, timeout = TIMEOUT) {
  // Direct browser access is intended: the key belongs to the user and stays
  // in their browser (bring-your-own-key).
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, timeout, maxRetries: 1 });
}

function anthropicError(err, model) {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return friendly(401, '', 'Anthropic', model);
  if (err instanceof Anthropic.NotFoundError) return friendly(404, '', 'Anthropic', model);
  if (err instanceof Anthropic.RateLimitError) return friendly(429, '', 'Anthropic', model);
  if (err instanceof Anthropic.APIError) return friendly(err.status ?? 0, String(err.message || ''), 'Anthropic', model);
  return new ProviderError('Could not reach Anthropic. Check your connection.', 0, 'network');
}

async function anthropicComplete(p, key, model, { system, user }, opts = {}) {
  try {
    const msg = await anthropicClient(key, opts.timeout).messages.create({
      model,
      max_tokens: opts.maxTokens || 16_000,
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (msg.stop_reason === 'refusal') throw new ProviderError('Claude declined to summarise this conversation.', 400, 'refusal');
    return msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    throw anthropicError(err, model);
  }
}

export async function providerComplete(providerId, key, model, prompt, opts) {
  const p = PROVIDERS[providerId];
  if (!p) throw new ProviderError('Unknown provider', 400);
  try {
    if (p.kind === 'anthropic') return await anthropicComplete(p, key, model, prompt, opts);
    if (p.kind === 'gemini') return await geminiComplete(p, key, model, prompt, opts);
    return await openaiComplete(p, key, model, prompt, opts);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err?.name === 'TimeoutError') throw new ProviderError(`${p.name} took too long to answer.`, 0, 'timeout');
    throw new ProviderError(`Could not reach ${p.name}. Check your connection.`, 0, 'network');
  }
}

/* ── model discovery & verification ────────────────────────────────── */

/** Lists model ids the key can see. Throws ProviderError('bad_key') for invalid keys. */
export async function listModels(providerId, key) {
  const p = PROVIDERS[providerId];
  if (!p) throw new ProviderError('Unknown provider', 400);
  let ids = [];
  try {
    if (p.kind === 'anthropic') {
      for await (const m of anthropicClient(key, 20_000).models.list({ limit: 100 })) ids.push(m.id);
    } else if (p.kind === 'gemini') {
      const res = await fetch(`${p.base}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        const detail = await readError(res);
        throw friendly(/API_KEY_INVALID|API key not valid/i.test(detail) ? 401 : res.status, detail, p.name, '');
      }
      const j = await res.json();
      ids = (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name).replace(/^models\//, ''));
    } else {
      if (providerId === 'openrouter') {
        // OpenRouter's model list is public, so validate the key separately.
        const k = await fetch(`${p.base}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
        if (k.status === 401 || k.status === 403) throw friendly(401, '', p.name, '');
      }
      const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw friendly(res.status, await readError(res), p.name, '');
      const j = await res.json();
      ids = (Array.isArray(j) ? j : j.data || []).map((m) => m.id);
    }
  } catch (err) {
    if (p.kind === 'anthropic') throw anthropicError(err, '');
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`Could not reach ${p.name} to verify the key.`, 0, 'network');
  }
  return [...new Set(ids.filter((id) => typeof id === 'string' && p.modelFilter(id)))].sort();
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function distance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Closest model ids to what the user typed (handles "claude-sonnet-4.5" vs "claude-sonnet-4-5"). */
export function suggestModels(typed, models, n = 3) {
  const t = norm(typed);
  if (!t) return models.slice(0, n);
  return models
    .map((m) => {
      const nm = norm(m);
      const bonus = nm.includes(t) || t.includes(nm) ? -3 : 0;
      return { m, score: distance(t, nm) + bonus };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((x) => x.m);
}

/**
 * Checks key -> model -> one tiny real request.
 * @returns {{models: string[], model: string, latencyMs: number, listed: boolean}}
 * @throws ProviderError with `.stage` ('key'|'model'|'request') and `.suggestions`
 */
export async function verify(providerId, key, model) {
  const p = PROVIDERS[providerId];
  if (!p) throw new ProviderError('Unknown provider', 400);
  if (!MODEL_ID_RE.test(model || '')) {
    const e = new ProviderError('Enter a model name, for example ' + p.examples[0] + '.', 400, 'bad_model');
    e.stage = 'model';
    throw e;
  }

  let models;
  try {
    models = await listModels(providerId, key);
  } catch (err) {
    err.stage = 'key';
    throw err;
  }
  const listed = models.includes(model);

  const started = Date.now();
  try {
    const out = await providerComplete(
      providerId,
      key,
      model,
      { system: 'You are a connectivity check. Reply with JSON only.', user: 'Return exactly {"ok": true}' },
      { maxTokens: 2_000, timeout: 45_000 },
    );
    if (!out || !out.trim()) throw new ProviderError(`"${model}" returned an empty reply.`, 0, 'empty');
  } catch (err) {
    err.stage = err.code === 'bad_key' ? 'key' : err.code === 'bad_model' || (!listed && err.status === 400) ? 'model' : 'request';
    if (err.stage === 'model') {
      err.code = 'bad_model';
      err.message = `${p.name} doesn't offer "${model}" to this key.`;
      err.suggestions = suggestModels(model, models);
    }
    err.models = models;
    throw err;
  }
  return { models, model, listed, latencyMs: Date.now() - started };
}
