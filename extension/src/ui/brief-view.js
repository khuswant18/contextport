/** Renders a packet's brief as readable HTML (text-only; safe for untrusted content). */

import { h } from './dom.js';
import { platformName } from '../../../shared/constants.js';

const section = (title, body) => (body ? [h('h4', { text: title }), body] : null);
const list = (items, ordered = false) => (items?.length ? h(ordered ? 'ol' : 'ul', {}, items.map((x) => h('li', { text: x }))) : null);
const para = (text) => (text ? h('p', { text }) : null);

export function renderBrief(packet) {
  const root = h('div', { class: 'brief' });
  if (packet.mode === 'full') {
    root.append(h('h3', { text: packet.source.title || 'Full transcript' }));
    for (const m of packet.messages || []) {
      root.append(h('h4', { text: m.role === 'user' ? 'You' : platformName(packet.source.platform) }), h('p', { text: m.content.length > 1200 ? `${m.content.slice(0, 1200)}…` : m.content }));
    }
    return root;
  }
  const b = packet.brief;
  root.append(
    h('h3', { text: b.title || 'Conversation brief' }),
    ...[
      section('Goal', para(b.goal)),
      section('What happened', para(b.summary)),
      section('Your requirements', list(b.userPreferences)),
      section('Key facts', list(b.keyFacts)),
      section('Decisions', list(b.decisions)),
      section('Tried so far', list(b.attempts)),
      section('Where it stands', para(b.currentState)),
      section('Next steps', list(b.nextSteps, true)),
      section('Open questions', list(b.openQuestions)),
    ]
      .flat()
      .filter(Boolean),
  );
  if (packet.code?.length) {
    root.append(h('h4', { text: `Code (${packet.code.length}, kept exactly)` }));
    for (const c of packet.code) {
      if (c.lang) root.append(h('div', { class: 'lang', text: c.lang }));
      root.append(h('pre', { text: c.code }));
    }
  }
  return root;
}

export function approxTokens(text) {
  const n = Math.ceil((text || '').length / 3.8);
  return n >= 1000 ? `≈${(n / 1000).toFixed(1)}k tokens` : `≈${n} tokens`;
}
