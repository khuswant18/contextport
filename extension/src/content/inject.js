/**
 * Inserts text into a destination composer (textarea, ProseMirror, Quill…)
 * in one operation. Never submits.
 */

export function waitForComposer(adapter, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const found = adapter.composer();
    if (found) return resolve(found);
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Couldn't find the ${adapter.name} message box`));
    }, timeoutMs);
    const observer = new MutationObserver(() => {
      const el = adapter.composer();
      if (el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

export function composerText(el) {
  if (!el) return '';
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
  return el.innerText || el.textContent || '';
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasText(el, text) {
  const probe = norm(text).slice(0, 60);
  return norm(composerText(el)).includes(probe);
}

function setTextareaValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectAll(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function moveCaretToEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * @param {'replace'|'append'} mode
 * @returns {Promise<'verified'|'inserted'>}
 */
export async function insertText(el, text, mode = 'replace') {
  el.focus();
  await sleep(30);

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const current = mode === 'append' && el.value ? `${el.value}\n\n` : '';
    setTextareaValue(el, current + text);
    await sleep(80);
    if (hasText(el, text)) return 'verified';
    throw new Error('The message box did not accept the text');
  }

  const before = composerText(el).length;
  if (mode === 'append') moveCaretToEnd(el);
  else selectAll(el);

  // 1) Synthetic paste — ProseMirror (ChatGPT, Claude) and Quill (Gemini) handle this natively.
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', mode === 'append' ? `\n\n${text}` : text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  } catch {
    /* fall through */
  }
  await sleep(150);
  if (hasText(el, text)) return 'verified';

  // Some editors turn long pastes into an attachment chip; that still counts.
  if (composerText(el).length !== before || document.querySelector('[data-testid*="pasted" i], [data-testid="file-thumbnail"]')) {
    return 'inserted';
  }

  // 2) execCommand fallback.
  if (mode !== 'append') selectAll(el);
  document.execCommand('insertText', false, text);
  await sleep(150);
  if (hasText(el, text)) return 'verified';
  if (composerText(el).length > before) return 'inserted';
  throw new Error('The message box did not accept the text');
}
