/**
 * Hosted model client (Groq). The provider and model are an internal detail:
 * nothing here is ever returned to clients.
 *
 * - Rotates across several models so one model's per-minute token limit
 *   doesn't block users.
 * - Tracks remaining tokens from rate-limit headers and skips exhausted models.
 * - Bounds concurrency with a small queue; rejects with 503 when saturated.
 */

import { config } from './config.js';
import { HttpError } from './http.js';
import { estimateTokens } from '../../shared/constants.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 45_000;
const MAX_WAIT_FOR_CAPACITY_MS = 12_000;

/** model -> { blockedUntil, remainingTokens, tokensResetAt } */
const modelState = new Map();

function parseDuration(s) {
  // Groq formats: "2.377s", "1m26.4s", "450ms"
  if (!s) return 0;
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m;
  while ((m = re.exec(s))) {
    const v = Number.parseFloat(m[1]);
    ms += m[2] === 'h' ? v * 3_600_000 : m[2] === 'm' ? v * 60_000 : m[2] === 's' ? v * 1000 : v;
  }
  return Math.ceil(ms);
}

function stateFor(model) {
  if (!modelState.has(model)) modelState.set(model, { blockedUntil: 0, remainingTokens: Infinity, tokensResetAt: 0 });
  return modelState.get(model);
}

function hasCapacity(model, needed, now) {
  const s = stateFor(model);
  if (s.blockedUntil > now) return false;
  if (s.tokensResetAt <= now) return true;
  return s.remainingTokens >= needed;
}

function earliestAvailability(needed, now) {
  let best = Infinity;
  for (const model of config.groqModels) {
    const s = stateFor(model);
    const t = Math.max(s.blockedUntil, s.remainingTokens >= needed ? 0 : s.tokensResetAt);
    best = Math.min(best, t);
  }
  return best - now;
}

/* ── concurrency gate ─────────────────────────────────────────────── */
let active = 0;
const waiting = [];

async function acquire() {
  if (active < config.maxConcurrentModelCalls) {
    active++;
    return;
  }
  if (waiting.length >= config.maxQueuedModelCalls) {
    throw new HttpError(503, 'ContextPort AI is busy right now. Please try again in a minute.', { retryAfter: 30 });
  }
  await new Promise((resolve) => waiting.push(resolve));
  active++;
}

function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

function modelParams(model) {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low', include_reasoning: false };
  return {};
}

async function callOnce(model, system, user, maxTokens) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: maxTokens,
      ...modelParams(model),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const s = stateFor(model);
  const remaining = Number(res.headers.get('x-ratelimit-remaining-tokens'));
  if (Number.isFinite(remaining)) {
    s.remainingTokens = remaining;
    s.tokensResetAt = Date.now() + parseDuration(res.headers.get('x-ratelimit-reset-tokens'));
  }

  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 20_000;
    s.blockedUntil = Date.now() + wait;
    return { retry: true, rateLimited: true };
  }
  if (res.status >= 500) {
    s.blockedUntil = Date.now() + 10_000;
    return { retry: true };
  }
  if (!res.ok) {
    // 400s: usually the prompt exceeds this model's limits. Try another model.
    // Log only the status and error type — never bodies, which could echo conversation text.
    const type = await res.json().then((j) => j?.error?.type || j?.error?.code || '').catch(() => '');
    console.warn(`[model] upstream ${res.status} ${String(type).slice(0, 40)}`);
    return { retry: true };
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  const tokens = Number(json?.usage?.total_tokens) || 0;
  if (!text) return { retry: true };
  return { text, tokens };
}

/**
 * @returns {Promise<{text: string, tokens: number}>}
 */
export async function hostedComplete({ system, user }) {
  const maxTokens = config.hostedMaxOutputTokens;
  const needed = estimateTokens(system) + estimateTokens(user) + maxTokens;
  const deadline = Date.now() + MAX_WAIT_FOR_CAPACITY_MS;

  const busy = () => new HttpError(503, 'ContextPort AI is at capacity right now. Please try again in a minute.', { retryAfter: 60 });

  await acquire();
  try {
    const failed = new Set(); // models that rejected this specific request
    let attempts = 0;
    for (;;) {
      const now = Date.now();
      const usable = config.groqModels.filter((m) => !failed.has(m));
      if (usable.length === 0 || attempts >= 5) throw busy();
      const model = usable.find((m) => hasCapacity(m, needed, now));
      if (model) {
        attempts++;
        try {
          const r = await callOnce(model, system, user, maxTokens);
          if (!r.retry) return r;
          if (!r.rateLimited) failed.add(model);
        } catch (err) {
          console.warn(`[model] call failed: ${err.name}`);
          stateFor(model).blockedUntil = Date.now() + 5_000;
        }
        continue;
      }
      // All usable models are rate-limited: wait briefly for capacity, else give up.
      const waitMs = earliestAvailability(needed, now);
      if (!Number.isFinite(waitMs) || now + waitMs > deadline) throw busy();
      await new Promise((r) => setTimeout(r, Math.max(250, waitMs)));
    }
  } finally {
    release();
  }
}

export function _resetModelStateForTests() {
  modelState.clear();
}
