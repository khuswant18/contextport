/**
 * Builds a claude.ai-like page (same selectors as the real app) for tests.
 * The real claude.ai requires a login, so E2E tests route claude.ai to this.
 */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function mdToHtml(md) {
  const parts = md.split(/```(\w*)\n([\s\S]*?)```/g);
  let html = '';
  for (let i = 0; i < parts.length; i += 3) {
    const text = parts[i].trim();
    if (text) html += text.split(/\n{2,}/).map((p) => `<p class="whitespace-normal">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    if (i + 2 < parts.length) {
      const lang = parts[i + 1];
      html += `<div class="relative"><div class="text-xs">${esc(lang)}</div><button aria-label="Copy to clipboard">Copy</button><pre class="code-block__code"><code class="language-${esc(lang)}">${esc(parts[i + 2])}</code></pre></div>`;
    }
  }
  return html;
}

export function claudePage(conversation = [], title = 'New chat') {
  const turns = conversation
    .map((m) =>
      m.role === 'user'
        ? `<div class="mb-1"><div data-testid="user-message" class="font-user-message">${mdToHtml(m.content)}</div></div>`
        : `<div data-is-streaming="false"><div class="font-claude-response"><div class="standard-markdown">${mdToHtml(m.content)}</div></div><div role="group"><button aria-label="Copy">Copy</button></div></div>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Claude</title>
<style>body{font-family:system-ui;margin:0;background:#faf9f5}main{max-width:720px;margin:0 auto;padding:24px 16px 160px}
[data-testid=user-message]{background:#f0eee6;border-radius:12px;padding:8px 14px;margin:16px 0}
pre{background:#fff;padding:12px;border-radius:8px;overflow:auto}
fieldset{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);width:680px;border:1px solid #ddd;border-radius:16px;background:#fff;padding:12px}
.ProseMirror{min-height:48px;outline:none;white-space:pre-wrap}</style></head>
<body><main>${turns}</main>
<fieldset><div class="ProseMirror" contenteditable="true" translate="no" role="textbox" aria-label="Write your prompt to Claude"><p><br></p></div></fieldset>
</body></html>`;
}
