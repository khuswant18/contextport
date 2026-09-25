/**
 * chatgpt.com-like page (2026 markup: li[data-message-role], textarea composer).
 * Used by engagement tests so they don't depend on ChatGPT's bot checks.
 */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function chatgptPage(conversation = []) {
  const items = conversation
    .map((m, i) =>
      m.role === 'user'
        ? `<li data-message-role="user" id="u${i}"><h4 data-message-attribution>You said:</h4><button data-user-message-bubble><p data-user-message-copy>${esc(m.content)}</p></button></li>`
        : `<li data-message-role="assistant" id="a${i}" data-assistant-content-started data-message-complete><h4 data-message-attribution>ChatGPT said:</h4><div data-assistant-markdown><p>${esc(m.content).replace(/\n/g, '<br>')}</p></div></li>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT</title>
<style>body{font-family:system-ui;margin:0}ol{list-style:none;max-width:720px;margin:0 auto;padding:24px 16px 200px}
li{margin:16px 0}[data-message-role=user] button{all:unset;display:block;background:#eee;border-radius:14px;padding:8px 14px}
form{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);width:680px}textarea{width:100%;height:60px}</style></head>
<body><main><ol>${items}</ol></main><form onsubmit="return false"><textarea aria-label="Chat with ChatGPT" id="prompt-textarea"></textarea></form></body></html>`;
}
