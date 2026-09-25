/**
 * The brief pipeline: sanitize -> extract code -> budget transcript -> model -> normalise.
 * `callModel` is injected so the same pipeline runs on the server (hosted AI)
 * and inside the extension (user's own key).
 */

import { sanitizeMessages, extractCode, renderTranscript, transcriptTokens } from './transcript.js';
import { BRIEF_SYSTEM_PROMPT, buildBriefUserPrompt } from './prompt.js';
import { parseJsonObject, normalizeBrief, buildOfflineBrief } from './brief.js';
import { selectCode } from './format.js';

export function prepare(messages) {
  const clean = sanitizeMessages(messages);
  const { messages: stripped, blocks } = extractCode(clean);
  return { clean, stripped, blocks };
}

/**
 * @param {object} args
 * @param {Array} args.messages untrusted messages
 * @param {string} args.sourcePlatform
 * @param {string} [args.title]
 * @param {number} args.budgetTokens transcript budget for the model input
 * @param {(req: {system: string, user: string}) => Promise<string>} args.callModel
 */
export async function createBrief({ messages, sourcePlatform, title, budgetTokens, callModel, detail = 'standard' }) {
  const { clean, stripped, blocks } = prepare(messages);
  const { text, omitted } = renderTranscript(stripped, budgetTokens);
  const user = buildBriefUserPrompt({
    transcript: text,
    sourcePlatform,
    title,
    messageCount: clean.length,
    omitted,
    codeCount: blocks.length,
    detail,
  });
  const raw = await callModel({ system: BRIEF_SYSTEM_PROMPT, user });
  const brief = normalizeBrief(parseJsonObject(raw), blocks.length);
  // If the model picked no code but code exists, keep the most recent block.
  if (brief.codeRefs.length === 0 && blocks.length > 0) brief.codeRefs = [blocks[blocks.length - 1].id];
  return {
    brief,
    code: selectCode(blocks, brief.codeRefs),
    stats: { messages: clean.length, codeBlocks: blocks.length, omitted, inputTokens: transcriptTokens(clean) },
  };
}

export function createOfflineBrief({ messages, title }) {
  const { clean, stripped, blocks } = prepare(messages);
  const brief = buildOfflineBrief(stripped, blocks, title);
  return {
    brief,
    code: selectCode(blocks, brief.codeRefs),
    stats: { messages: clean.length, codeBlocks: blocks.length, omitted: 0, inputTokens: transcriptTokens(clean) },
  };
}
