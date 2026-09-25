/**
 * Brief normalisation (untrusted model output -> safe, bounded object),
 * and the offline brief builder used when no model is available.
 */

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+\n/g, '\n').trim().slice(0, max) : '');

const list = (v, maxItems = 12, maxLen = 600) =>
  Array.isArray(v)
    ? v
        .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? Object.values(x).filter((y) => typeof y === 'string').join(' -> ') : ''))
        .map((x) => x.trim().slice(0, maxLen))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.slice(0, 500) : '';
  } catch {
    return '';
  }
}

/** Extracts the first JSON object from model text (handles code fences / preambles). */
export function parseJsonObject(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty model response');
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Model did not return JSON');
  }
}

/**
 * @param {unknown} raw parsed model JSON
 * @param {number} codeCount number of extracted code blocks
 */
export function normalizeBrief(raw, codeCount) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const refs = Array.isArray(r.codeRefs)
    ? [...new Set(r.codeRefs.map((n) => Number.parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= codeCount))]
    : [];
  const links = Array.isArray(r.links)
    ? r.links
        .map((l) => ({ title: str(l?.title, 160), url: safeUrl(l?.url) }))
        .filter((l) => l.url)
        .slice(0, 10)
    : [];
  const brief = {
    title: str(r.title, 120),
    goal: str(r.goal, 800),
    summary: str(r.summary, 4000),
    userPreferences: list(r.userPreferences),
    keyFacts: list(r.keyFacts, 16),
    decisions: list(r.decisions),
    attempts: list(r.attempts),
    currentState: str(r.currentState, 2500),
    nextSteps: list(r.nextSteps, 8),
    openQuestions: list(r.openQuestions, 8),
    codeRefs: refs,
    links,
  };
  if (!brief.goal && !brief.summary && !brief.currentState) throw new Error('Model returned an empty brief');
  return brief;
}

function firstSentence(text, max = 220) {
  const t = text.replace(/\[\[code #\d+:[^\]]*\]\]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  return (m ? m[1] : t).slice(0, max);
}

/**
 * Deterministic brief built without any model. Honest about being extractive.
 * @param {{role: string, content: string}[]} stripped messages with code markers
 * @param {{id: number}[]} blocks extracted code blocks
 */
export function buildOfflineBrief(stripped, blocks, title) {
  const users = stripped.filter((m) => m.role === 'user');
  const assistants = stripped.filter((m) => m.role === 'assistant');
  const firstUser = users[0]?.content || '';
  const lastUser = users[users.length - 1]?.content || '';
  const lastAssistant = assistants[assistants.length - 1]?.content || '';

  const requests = users.slice(-8).map((m) => firstSentence(m.content));
  const lastBlocks = blocks.slice(-4).map((b) => b.id);

  return {
    title: (title || firstSentence(firstUser, 80) || 'Continuing a conversation').slice(0, 120),
    goal: firstUser.replace(/\s+/g, ' ').slice(0, 800),
    summary: `The conversation has ${stripped.length} messages (${users.length} from the user). What the user asked, in order:\n${requests.map((r) => `- ${r}`).join('\n')}`,
    userPreferences: [],
    keyFacts: [],
    decisions: [],
    attempts: [],
    currentState: lastAssistant ? `Latest assistant reply:\n${lastAssistant.slice(0, 2500)}` : '',
    nextSteps: users.length > 1 ? [`Continue with the latest request: ${firstSentence(lastUser, 400)}`] : [],
    openQuestions: [],
    codeRefs: lastBlocks,
    links: [],
  };
}
