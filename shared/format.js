/**
 * Turns a packet into the text pasted into the destination AI.
 * Claude gets XML-tagged sections (what it parses best); others get Markdown.
 */

import { platformName } from './constants.js';

const MAX_CODE_CHARS = 40_000;
const MAX_TRANSCRIPT_CHARS = 150_000;

function fence(code, lang) {
  const ticks = code.includes('```') ? '````' : '```';
  return `${ticks}${lang || ''}\n${code}\n${ticks}`;
}

/** Picks the referenced code blocks, within a total size cap. */
export function selectCode(blocks, refs) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const out = [];
  let used = 0;
  for (const id of refs) {
    const b = byId.get(id);
    if (!b) continue;
    const code = b.code.length > 15_000 ? `${b.code.slice(0, 15_000)}\n… (truncated)` : b.code;
    if (used + code.length > MAX_CODE_CHARS) break;
    used += code.length;
    out.push({ id: b.id, lang: b.lang, code });
  }
  return out;
}

const bullets = (items) => items.map((x) => `- ${x}`).join('\n');
const numbered = (items) => items.map((x, i) => `${i + 1}. ${x}`).join('\n');

function markdownSections(p, aboutMe) {
  const b = p.brief;
  const out = [];
  if (b.title) out.push(`# ${b.title}`);
  if (aboutMe) out.push(`## About me\n${aboutMe}`);
  if (b.goal) out.push(`## Goal\n${b.goal}`);
  if (b.summary) out.push(`## What happened so far\n${b.summary}`);
  if (b.userPreferences.length) out.push(`## My requirements and preferences\n${bullets(b.userPreferences)}`);
  if (b.keyFacts.length) out.push(`## Key facts\n${bullets(b.keyFacts)}`);
  if (b.decisions.length) out.push(`## Decisions made\n${bullets(b.decisions)}`);
  if (b.attempts.length) out.push(`## What we tried\n${bullets(b.attempts)}`);
  if (b.currentState) out.push(`## Where we are now\n${b.currentState}`);
  if (p.code.length) out.push(`## Relevant code\n${p.code.map((c) => fence(c.code, c.lang)).join('\n\n')}`);
  if (b.nextSteps.length) out.push(`## Next steps\n${numbered(b.nextSteps)}`);
  if (b.openQuestions.length) out.push(`## Open questions\n${bullets(b.openQuestions)}`);
  if (b.links.length) out.push(`## Links\n${bullets(b.links.map((l) => (l.title ? `${l.title}: ${l.url}` : l.url)))}`);
  return out;
}

function markdownBrief(p, aboutMe) {
  const src = platformName(p.source.platform);
  return [
    `I'm continuing work I started in ${src}. Here's the full context so you can pick up exactly where we left off.`,
    ...markdownSections(p, aboutMe),
    '---\nPlease confirm in one or two sentences that you understand the goal and where we left off, then continue with the first next step.',
  ].join('\n\n');
}

const xmlEsc = (s) => String(s).replace(/</g, '‹').replace(/>/g, '›');

function claudeBrief(p, aboutMe) {
  const b = p.brief;
  const src = platformName(p.source.platform);
  const tag = (name, body) => `<${name}>\n${body}\n</${name}>`;
  const out = [`I'm continuing work I started in ${src}. Here is the full context so you can pick up exactly where we left off.`, ''];
  const inner = [];
  if (b.title) inner.push(tag('title', xmlEsc(b.title)));
  if (aboutMe) inner.push(tag('about_me', xmlEsc(aboutMe)));
  if (b.goal) inner.push(tag('goal', xmlEsc(b.goal)));
  if (b.summary) inner.push(tag('history', xmlEsc(b.summary)));
  if (b.userPreferences.length) inner.push(tag('my_requirements', xmlEsc(bullets(b.userPreferences))));
  if (b.keyFacts.length) inner.push(tag('key_facts', xmlEsc(bullets(b.keyFacts))));
  if (b.decisions.length) inner.push(tag('decisions', xmlEsc(bullets(b.decisions))));
  if (b.attempts.length) inner.push(tag('attempts', xmlEsc(bullets(b.attempts))));
  if (b.currentState) inner.push(tag('current_state', xmlEsc(b.currentState)));
  if (p.code.length) inner.push(tag('code', p.code.map((c) => fence(c.code, c.lang)).join('\n\n')));
  if (b.nextSteps.length) inner.push(tag('next_steps', xmlEsc(numbered(b.nextSteps))));
  if (b.openQuestions.length) inner.push(tag('open_questions', xmlEsc(bullets(b.openQuestions))));
  if (b.links.length) inner.push(tag('links', bullets(b.links.map((l) => (l.title ? `${xmlEsc(l.title)}: ${l.url}` : l.url)))));
  out.push(tag('handoff', inner.join('\n')));
  out.push('', 'Please confirm in one or two sentences that you understand the goal and where we left off, then continue with the first next step.');
  return out.join('\n');
}

/** Full transcript mode: the conversation itself, trimmed only if enormous. */
export function formatTranscript(messages, sourcePlatform, aboutMe) {
  const src = platformName(sourcePlatform);
  const render = (m) => `**${m.role === 'user' ? 'Me' : src}:**\n${m.content}`;
  let parts = messages.map(render);
  let note = '';
  let total = parts.reduce((a, s) => a + s.length + 2, 0);
  if (total > MAX_TRANSCRIPT_CHARS) {
    const kept = [parts[0]];
    let used = parts[0].length;
    const tail = [];
    for (let i = parts.length - 1; i > 0; i--) {
      if (used + parts[i].length > MAX_TRANSCRIPT_CHARS) break;
      tail.unshift(parts[i]);
      used += parts[i].length;
    }
    const omitted = parts.length - 1 - tail.length;
    note = `\n\n(${omitted} older messages were left out to fit the length limit.)`;
    parts = [...kept, `[… ${omitted} messages omitted …]`, ...tail];
    total = used;
  }
  const me = aboutMe ? `\n\nAbout me:\n${aboutMe}` : '';
  return `I'm continuing a conversation from ${src}. Below is the transcript.${note}${me}

---

${parts.join('\n\n')}

---

Please read the conversation above, confirm briefly where we left off, and continue from there.`;
}

/**
 * @param {object} packet { mode, brief, code, source, messages? }
 * @param {string} destination platform id
 */
export function formatHandoff(packet, destination, { aboutMe = '' } = {}) {
  const me = String(aboutMe || '').trim().slice(0, 3000);
  if (packet.mode === 'full') return formatTranscript(packet.messages || [], packet.source.platform, me);
  return destination === 'claude' ? claudeBrief(packet, me) : markdownBrief(packet, me);
}

/** Standalone Markdown document for export (Obsidian, Notion, files). */
export function exportMarkdown(packet, createdAt = Date.now()) {
  const src = platformName(packet.source.platform);
  const date = new Date(createdAt).toISOString().slice(0, 10);
  const head = `> ContextPort brief · from ${src} · ${date}${packet.source.url ? ` · [original chat](${packet.source.url})` : ''}`;
  if (packet.mode === 'full') return `${head}\n\n${formatTranscript(packet.messages || [], packet.source.platform)}`;
  return [head, ...markdownSections(packet, '')].join('\n\n');
}
