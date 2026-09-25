/**
 * Transcript preparation: validation, code-block extraction and token budgeting.
 *
 * Code is pulled out of the conversation before it reaches a model and replaced
 * with short markers. The model only chooses which blocks matter, and the exact
 * code is re-attached afterwards, so code is never paraphrased or lost and the
 * model's input budget is spent on the conversation itself.
 */

import { LIMITS, estimateTokens } from './constants.js';

const FENCE_RE = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g;

/**
 * Validates and normalises untrusted message input. Throws on invalid input.
 * @returns {{role: 'user'|'assistant', content: string}[]}
 */
export function sanitizeMessages(input) {
  if (!Array.isArray(input)) throw new InputError('messages must be an array');
  if (input.length === 0) throw new InputError('No messages found in this conversation');
  if (input.length > LIMITS.maxMessages) throw new InputError(`Too many messages (max ${LIMITS.maxMessages})`);

  let total = 0;
  const out = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') throw new InputError('Invalid message');
    const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : null;
    if (!role) throw new InputError('Invalid message role');
    if (typeof m.content !== 'string') throw new InputError('Invalid message content');
    // Strip NULs and other control chars except tab/newline.
    const content = m.content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (!content) continue;
    if (content.length > LIMITS.maxMessageChars) throw new InputError('A message is too long');
    total += content.length;
    if (total > LIMITS.maxTotalChars) throw new InputError('Conversation is too long');
    out.push({ role, content });
  }
  if (out.length === 0) throw new InputError('No messages found in this conversation');
  return out;
}

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.status = 400;
  }
}

/**
 * Replaces fenced code blocks with numbered markers.
 * Identical code (e.g. repeated snippets) shares one block number.
 */
export function extractCode(messages) {
  const blocks = [];
  const seen = new Map();
  const stripped = messages.map((m, msgIndex) => {
    const content = m.content.replace(FENCE_RE, (_, lang, code) => {
      const body = code.replace(/\s+$/, '');
      if (!body.trim()) return '';
      let id = seen.get(body);
      if (!id) {
        id = blocks.length + 1;
        seen.set(body, id);
        blocks.push({ id, lang: (lang || '').toLowerCase().slice(0, 24), code: body, msgIndex, role: m.role });
      }
      const lines = body.split('\n').length;
      return `[[code #${id}: ${lang || 'text'}, ${lines} line${lines === 1 ? '' : 's'}]]`;
    });
    return { role: m.role, content };
  });
  return { messages: stripped, blocks };
}

function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[… ${text.length - maxChars} characters trimmed …]\n${text.slice(-tail)}`;
}

/**
 * Renders messages into a transcript that fits a token budget.
 * Keeps the opening request and the most recent turns in full; older middle
 * turns are shortened first, then omitted.
 */
export function renderTranscript(messages, budgetTokens) {
  const budgetChars = Math.floor(budgetTokens * 3.6);
  const perMsgCap = Math.max(1200, Math.floor(budgetChars * 0.35));
  const label = (m, i) => `### [${i + 1}] ${m.role === 'user' ? 'USER' : 'ASSISTANT'}\n`;

  const full = messages.map((m, i) => label(m, i) + clip(m.content, perMsgCap));
  const totalLen = full.reduce((a, s) => a + s.length + 2, 0);
  if (totalLen <= budgetChars) return { text: full.join('\n\n'), omitted: 0, trimmed: false };

  // Always keep the first user message (it usually states the goal).
  const firstIdx = messages.findIndex((m) => m.role === 'user');
  const first = firstIdx >= 0 ? label(messages[firstIdx], firstIdx) + clip(messages[firstIdx].content, Math.min(perMsgCap, 3000)) : '';
  let used = first.length + 80;
  const tailParts = [];
  let i = messages.length - 1;

  // Newest first, in full while it fits.
  for (; i > firstIdx; i--) {
    const s = full[i];
    if (used + s.length + 2 > budgetChars * 0.8) break;
    tailParts.unshift(s);
    used += s.length + 2;
  }
  // Then shortened versions of older turns.
  for (; i > firstIdx; i--) {
    const s = label(messages[i], i) + clip(messages[i].content, 500);
    if (used + s.length + 2 > budgetChars) break;
    tailParts.unshift(s);
    used += s.length + 2;
  }
  const omitted = Math.max(0, i - firstIdx);
  const parts = [];
  if (first) parts.push(first);
  if (omitted > 0) parts.push(`[… ${omitted} earlier message${omitted === 1 ? '' : 's'} omitted for length …]`);
  parts.push(...tailParts);
  return { text: parts.join('\n\n'), omitted, trimmed: true };
}

export function transcriptTokens(messages) {
  return messages.reduce((a, m) => a + estimateTokens(m.content), 0);
}
