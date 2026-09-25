/**
 * Converts a rendered chat message (DOM) back into Markdown.
 *
 * Reading innerText loses code fences, list structure and tables, which is why
 * earlier versions dropped all code. This walker keeps them, and skips UI
 * chrome such as copy buttons, icons and screen-reader-only labels.
 */

const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'svg', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'MAT-ICON', 'GEM-ICON-BUTTON', 'SOURCES-LIST', 'MESSAGE-ACTIONS']);
const SKIP_SELECTOR = [
  '[aria-hidden="true"]',
  '[hidden]',
  '.sr-only',
  '.cdk-visually-hidden',
  '.visually-hidden',
  '[data-message-attribution]',
  '[data-message-content-controls]',
  '[data-contextport]',
  '.katex-html',
].join(',');

const LANG_RE = /^[A-Za-z][\w+#.-]{0,23}$/;
const COMMON_LANGS = /^(python|javascript|typescript|js|ts|tsx|jsx|java|kotlin|swift|go|rust|ruby|php|c|cpp|c\+\+|c#|csharp|bash|shell|sh|zsh|powershell|sql|json|yaml|yml|toml|xml|html|css|scss|markdown|md|dockerfile|makefile|prisma|graphql|r|scala|dart|lua|perl|haskell|elixir|text|plaintext|diff|ini|env)$/i;

function codeLanguage(pre) {
  const code = pre.querySelector('code') || pre;
  const cls = `${code.className || ''} ${pre.className || ''}`;
  const m = /(?:language|lang)-([\w+#.-]+)/.exec(cls);
  if (m) return m[1].toLowerCase();
  const dataLang = pre.getAttribute('data-language') || code.getAttribute('data-language');
  if (dataLang && LANG_RE.test(dataLang)) return dataLang.toLowerCase();
  // Header label near the block (Gemini, ChatGPT and Claude render one).
  let container = pre.parentElement;
  for (let depth = 0; container && depth < 4; depth++, container = container.parentElement) {
    const labels = container.querySelectorAll('span, div');
    for (const el of labels) {
      if (el.contains(pre) || pre.contains(el) || el.children.length > 0) continue;
      const t = (el.textContent || '').trim();
      if (t && t.length < 24 && COMMON_LANGS.test(t)) return t.toLowerCase();
    }
  }
  return '';
}

function codeText(pre) {
  const code = pre.querySelector('code') || pre;
  const clone = code.cloneNode(true);
  clone.querySelectorAll('button, [data-message-content-controls], [aria-hidden="true"]').forEach((n) => n.remove());
  return clone.textContent.replace(/ /g, ' ').replace(/\n+$/, '');
}

function shouldSkip(el) {
  if (SKIP_TAGS.has(el.tagName)) return true;
  try {
    return el.matches(SKIP_SELECTOR);
  } catch {
    return false;
  }
}

function inline(s) {
  return s.replace(/ /g, ' ');
}

function walk(node, ctx, out) {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(inline(node.nodeValue));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node;
  if (shouldSkip(el)) return;
  const tag = el.tagName;

  if (tag === 'PRE') {
    const lang = codeLanguage(el);
    const code = codeText(el);
    const ticks = code.includes('```') ? '````' : '```';
    // Stash code so whitespace cleanup below never touches it.
    ctx.codes.push(`${ticks}${lang}\n${code}\n${ticks}`);
    out.push(`\n\n\u0000${ctx.codes.length - 1}\u0000\n\n`);
    return;
  }
  if (el.classList?.contains('katex')) {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]');
    if (tex) {
      out.push(el.closest('.katex-display') ? `\n$$${tex.textContent}$$\n` : `$${tex.textContent}$`);
      return;
    }
  }
  if (tag === 'CODE') {
    out.push('`' + el.textContent + '`');
    return;
  }
  if (tag === 'BR') {
    out.push('\n');
    return;
  }
  if (tag === 'IMG') {
    const alt = (el.getAttribute('alt') || '').trim();
    if (alt) out.push(`[image: ${alt}]`);
    return;
  }
  if (/^H[1-6]$/.test(tag)) {
    out.push(`\n\n${'#'.repeat(Number(tag[1]))} `);
    el.childNodes.forEach((c) => walk(c, ctx, out));
    out.push('\n\n');
    return;
  }
  if (tag === 'UL' || tag === 'OL') {
    const inner = { ...ctx, list: tag, depth: (ctx.depth ?? -1) + 1, n: 0 };
    out.push('\n');
    el.childNodes.forEach((c) => walk(c, inner, out));
    out.push('\n');
    return;
  }
  if (tag === 'LI') {
    ctx.n = (ctx.n || 0) + 1;
    const indent = '  '.repeat(Math.max(0, ctx.depth || 0));
    out.push(`\n${indent}${ctx.list === 'OL' ? `${ctx.n}.` : '-'} `);
    el.childNodes.forEach((c) => walk(c, ctx, out));
    return;
  }
  if (tag === 'TABLE') {
    const rows = [...el.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((cell) => cell.textContent.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()),
    );
    if (rows.length) {
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
      out.push(`\n\n${line(rows[0])}\n| ${Array(width).fill('---').join(' | ')} |\n${rows.slice(1).map(line).join('\n')}\n\n`);
    }
    return;
  }
  if (tag === 'A') {
    const href = el.getAttribute('href') || '';
    const text = el.textContent.trim();
    if (/^https?:\/\//.test(href) && text && text !== href) out.push(`[${text}](${href})`);
    else out.push(text || href);
    return;
  }
  if (tag === 'STRONG' || tag === 'B') {
    const t = el.textContent;
    out.push(t.trim() ? `**${t.trim()}**` : t);
    return;
  }
  if (tag === 'BLOCKQUOTE') {
    const inner = [];
    el.childNodes.forEach((c) => walk(c, ctx, inner));
    out.push(`\n\n${inner.join('').trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`);
    return;
  }
  if (tag === 'HR') {
    out.push('\n\n---\n\n');
    return;
  }

  const block = tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE';
  if (block) out.push('\n');
  el.childNodes.forEach((c) => walk(c, ctx, out));
  if (block) out.push('\n');
}

/** @param {Element} root */
export function toMarkdown(root) {
  if (!root) return '';
  const out = [];
  const codes = [];
  walk(root, { codes }, out);
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}
