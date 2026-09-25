/**
 * Platform adapters: find messages, detect streaming, find the composer.
 * Each selector list is ordered newest-UI-first, with older fallbacks, because
 * these sites change their markup often.
 */

import { toMarkdown } from './markdown.js';

const q = (sel, root = document) => root.querySelector(sel);
const qa = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Removes elements that are nested inside another matched element. */
function outermost(els) {
  return els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
}

function visible(el) {
  if (!el || !el.isConnected) return false;
  if (el.closest('[hidden], template')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

const chatgpt = {
  id: 'chatgpt',
  name: 'ChatGPT',
  hasReply: () => !!q('li[data-message-role="assistant"]:not([data-conversation-recovery]), [data-message-author-role="assistant"]'),
  statsSelectors: ['li[data-message-role]', '[data-message-author-role]'],
  messages() {
    // 2026 UI: <li data-message-role> with [data-user-message-copy] / [data-assistant-markdown].
    const modern = qa('li[data-message-role]').filter((el) => !el.hasAttribute('data-conversation-recovery') && visible(el));
    if (modern.length) {
      return modern.map((el) => {
        const role = el.getAttribute('data-message-role') === 'user' ? 'user' : 'assistant';
        const body =
          role === 'user'
            ? q('[data-user-message-bubble]', el) || q('[data-user-message-copy]', el) || el
            : q('[data-assistant-markdown]', el) || el;
        return { role, el, content: toMarkdown(body) };
      });
    }
    // Earlier UI: [data-message-author-role].
    return outermost(qa('[data-message-author-role]')).map((el) => {
      const role = el.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant';
      const body = role === 'user' ? q('.whitespace-pre-wrap', el) || el : q('.markdown', el) || q('[class*="markdown"]', el) || el;
      return { role, el, content: toMarkdown(body) };
    });
  },
  isGenerating() {
    if (q('button[data-testid="stop-button"], button[aria-label*="Stop" i][aria-label*="generat" i], button[aria-label="Stop streaming"]')) return true;
    const last = qa('li[data-message-role="assistant"]:not([data-conversation-recovery])').pop();
    return !!(last && last.hasAttribute('data-assistant-content-started') && !last.hasAttribute('data-message-complete'));
  },
  composer() {
    return (
      q('#prompt-textarea[contenteditable="true"]') ||
      q('div.ProseMirror[contenteditable="true"]') ||
      q('textarea[aria-label="Chat with ChatGPT"]') ||
      q('form textarea') ||
      q('textarea#prompt-textarea') ||
      q('main [contenteditable="true"]')
    );
  },
};

const claude = {
  id: 'claude',
  name: 'Claude',
  hasReply: () => !!q('.font-claude-response, .font-claude-message, [data-testid="assistant-message"]'),
  statsSelectors: ['[data-testid="user-message"], .font-claude-response', '[data-testid="user-message"], .font-claude-message, [data-testid="assistant-message"]'],
  messages() {
    const els = outermost(qa('[data-testid="user-message"], .font-claude-response, .font-claude-message, [data-testid="assistant-message"]'));
    return els
      .filter(visible)
      .map((el) => {
        const role = el.matches('[data-testid="user-message"]') ? 'user' : 'assistant';
        let body = el;
        if (role === 'assistant') {
          // Prefer the answer markdown; skip "thinking" summaries when present.
          const parts = qa('.standard-markdown, .progressive-markdown', el).filter((p) => !p.closest('[data-testid*="thinking" i], details'));
          if (parts.length) {
            return { role, el, content: parts.map(toMarkdown).filter(Boolean).join('\n\n') };
          }
        }
        return { role, el, content: toMarkdown(body) };
      });
  },
  isGenerating() {
    return !!q('[data-is-streaming="true"], button[aria-label="Stop response"], button[aria-label*="Stop" i][data-testid*="stop" i]');
  },
  composer() {
    return (
      q('div.ProseMirror[contenteditable="true"]') ||
      q('[data-testid="chat-input"][contenteditable="true"]') ||
      q('fieldset [contenteditable="true"]') ||
      q('[contenteditable="true"][role="textbox"]') ||
      q('fieldset textarea')
    );
  },
};

const gemini = {
  id: 'gemini',
  name: 'Gemini',
  hasReply: () => !!q('model-response'),
  statsSelectors: ['user-query, model-response'],
  messages() {
    return qa('user-query, model-response')
      .filter(visible)
      .map((el) => {
        if (el.tagName === 'USER-QUERY') {
          const lines = qa('.query-text-line', el);
          const content = lines.length
            ? lines.map((l) => l.textContent.trim()).join('\n')
            : toMarkdown(q('.query-text', el) || q('user-query-content', el) || el);
          return { role: 'user', el, content };
        }
        const body = q('message-content', el) || q('.markdown', el) || q('model-response-content', el) || el;
        return { role: 'assistant', el, content: toMarkdown(body) };
      });
  },
  isGenerating() {
    if (q('button[aria-label*="Stop response" i], button[aria-label="Stop"]')) return true;
    const last = qa('model-response').pop();
    return !!(last && q('[aria-busy="true"]', last));
  },
  composer() {
    return (
      q('rich-textarea .ql-editor[contenteditable="true"]') ||
      q('div.ql-editor[contenteditable="true"]') ||
      q('[contenteditable="true"][role="textbox"]') ||
      q('textarea')
    );
  },
};

const perplexity = {
  id: 'perplexity',
  name: 'Perplexity',
  hasReply: () => !!q('[id^="markdown-content"], div.prose'),
  statsSelectors: ['[data-testid="user-query"], [id^="markdown-content"]', 'h1[class*="query"], div.prose'],
  messages() {
    const users = qa('[data-testid="user-query"], h1[class*="query"], div[class*="group/query"]');
    const answers = qa('[id^="markdown-content"], div.prose');
    const all = outermost([...users, ...answers]).filter(visible);
    all.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return all.map((el) => ({ role: users.includes(el) ? 'user' : 'assistant', el, content: toMarkdown(el) }));
  },
  isGenerating() {
    return !!q('button[aria-label*="Stop" i]');
  },
  composer() {
    return q('#ask-input[contenteditable="true"]') || q('div[contenteditable="true"][role="textbox"]') || q('textarea[placeholder]') || q('textarea');
  },
};

const BY_HOST = {
  'chatgpt.com': chatgpt,
  'chat.openai.com': chatgpt,
  'claude.ai': claude,
  'gemini.google.com': gemini,
  'www.perplexity.ai': perplexity,
  'perplexity.ai': perplexity,
};

export function currentAdapter() {
  return BY_HOST[location.hostname] || null;
}

/**
 * @param {'all'|'recent'|'last'} scope
 * @returns {{role: 'user'|'assistant', content: string}[]}
 */
export function readConversation(adapter, scope = 'all') {
  const raw = adapter.messages().filter((m) => m.content && m.content.trim());
  // Merge consecutive duplicates that some UIs render twice.
  const list = [];
  for (const { role, content } of raw) {
    const prev = list[list.length - 1];
    if (prev && prev.role === role && prev.content === content) continue;
    list.push({ role, content });
  }
  if (scope === 'last') {
    const lastA = list.map((m) => m.role).lastIndexOf('assistant');
    if (lastA === -1) return list.slice(-1);
    const prevU = list.slice(0, lastA).map((m) => m.role).lastIndexOf('user');
    return list.slice(prevU === -1 ? lastA : prevU, lastA + 1);
  }
  if (scope === 'recent') return list.slice(-10);
  return list;
}

/**
 * Cheap size estimate for the long-chat nudge: counts message elements and
 * their raw text. No Markdown conversion and no layout reads, so it is safe to
 * run while the user types.
 */
export function quickStats(adapter) {
  for (const sel of adapter.statsSelectors || []) {
    const els = document.querySelectorAll(sel);
    if (!els.length) continue;
    let chars = 0;
    for (const el of els) chars += el.textContent.length;
    return { count: els.length, chars };
  }
  return { count: 0, chars: 0 };
}

/**
 * Detects "you've hit your limit" notices. Only looks at small alert-like
 * elements and the blocks right around the message box, so normal answers
 * that mention limits don't trigger it. Uses textContent (no layout) and
 * measures only a matching element.
 */
const LIMIT_RE =
  /(you('|’)ve (reached|hit) (your|the) (usage |message |daily |free[- ]plan |free )?(limit|cap)|usage limit reached|message limit reached|out of (free )?messages|(limit|cap) resets? (at|in|on)|you('|’)ve used up|reached (the|your) limit for|free plan limit|try again (after|at) \d)/i;
const NOTICE_MAX_CHARS = 600;

export function findLimitNotice(adapter) {
  const candidates = [...document.querySelectorAll('[role="alert"], [role="status"], [data-testid*="limit" i], [class*="limit" i], [class*="banner" i], [class*="toast" i]')];
  // Limit notices usually replace or sit beside the message box.
  let node = adapter?.composer?.() || null;
  for (let i = 0; node && i < 4; i++) {
    node = node.parentElement;
    if (node) candidates.push(...node.children);
  }
  for (const el of candidates) {
    // Skip big containers (e.g. the whole thread) before reading their text.
    if (el.getElementsByTagName('*').length > 80) continue;
    const text = el.textContent || '';
    if (!text.trim() || text.length > NOTICE_MAX_CHARS || !LIMIT_RE.test(text)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return text.trim().slice(0, 200);
  }
  return null;
}
