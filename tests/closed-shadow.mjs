/**
 * The production build, as users get it: the in-page UI lives in a *closed*
 * shadow root, which Playwright locators can't enter. Other suites use the
 * test build (open shadow root), so bugs that only happen with a closed root
 * (e.g. page-level listeners that can't see inside it) slip past them.
 *
 * Here elements are found through the DevTools protocol (which can see closed
 * roots) and clicked with real mouse events at their on-screen position, the
 * way a user clicks. Also measures main-thread blocking while typing,
 * scrolling and moving the mouse on a very long chat.
 *
 *   npm --prefix server start
 *   node tests/closed-shadow.mjs            # ROUNDS=3 to repeat the whole suite
 */

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudePage } from './fixtures/claude-page.mjs';
import { chatgptPage } from './fixtures/chatgpt-page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const artifacts = path.join(here, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const conversation = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/conversation.json'), 'utf8'));
const API = 'http://localhost:8787';
const ROUNDS = Math.max(1, Number(process.env.ROUNDS) || 1);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

execSync('node extension/build.mjs', { cwd: root, stdio: 'ignore' });
if (!(await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false))) {
  console.error('Start the server first: npm --prefix server start');
  process.exit(1);
}

/* A long, realistically nested chat: 300 messages, code blocks and the kind
   of deep "rounded" wrappers the real sites use. */
function heavyChat() {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const wrap = (html, depth) => (depth ? `<div class="rounded-xl flex flex-col">${wrap(html, depth - 1)}</div>` : html);
  const items = Array.from({ length: 300 }, (_, i) => {
    if (i % 2 === 0) return `<li data-message-role="user"><button data-user-message-bubble><p data-user-message-copy>Question ${i}: ${'how do I make the invoice export faster '.repeat(4)}</p></button></li>`;
    const body = `<p>${'Here is a detailed explanation with several steps and caveats. '.repeat(12)}</p><pre><code class="language-js">${esc(`function step${i}(rows) {\n  return rows.map((r) => ({ ...r, total: r.qty * r.price }));\n}\n`.repeat(6))}</code></pre><ul>${'<li>point</li>'.repeat(8)}</ul>`;
    return `<li data-message-role="assistant" data-assistant-content-started data-message-complete><div data-assistant-markdown>${wrap(body, 12)}</div></li>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Heavy chat</title>
<style>body{font-family:system-ui;margin:0}ol{list-style:none;max-width:720px;margin:0 auto;padding:24px 16px 200px}form{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);width:680px}textarea{width:100%;height:60px}</style></head>
<body><main><ol>${items}</ol></main><form onsubmit="return false"><div class="rounded-3xl"><textarea aria-label="Chat with ChatGPT" id="prompt-textarea"></textarea></div></form></body></html>`;
}
const HEAVY = heavyChat();

const ext = path.join(root, 'extension/dist');
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: process.env.HEADED !== '1',
  viewport: { width: 1360, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');

await ctx.route('https://claude.ai/**', (r) => {
  if (r.request().resourceType() !== 'document') return r.abort();
  const p = new URL(r.request().url()).pathname;
  return r.fulfill({ contentType: 'text/html', body: claudePage(p.startsWith('/chat/') ? conversation : [], 'Invoice app') });
});
await ctx.route('https://chatgpt.com/**', (r) => {
  if (r.request().resourceType() !== 'document') return r.abort();
  const p = new URL(r.request().url()).pathname;
  return r.fulfill({ contentType: 'text/html', body: p.startsWith('/c/heavy') ? HEAVY : p.startsWith('/c/') ? chatgptPage(conversation) : chatgptPage([]) });
});

await sw.evaluate(() =>
  chrome.storage.local.set({
    aboutMe: 'I build invoicing tools. Prefer code first.',
    snippets: [{ id: 's1', name: 'Explain simply', text: 'Explain this like I am new to the topic.' }],
    seen: { tip_launcher: Date.now() },
  }),
);

/* ── DevTools helpers: see through the closed shadow root ─────────────── */

async function snapshot(page) {
  const s = await ctx.newCDPSession(page);
  const { root: doc } = await s.send('DOM.getDocument', { depth: -1, pierce: true });
  return { s, doc };
}

function classOf(n) {
  const a = n.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === 'class') return a[i + 1];
  return '';
}
function textOf(n) {
  return (n.nodeType === 3 ? n.nodeValue : '') + [...(n.children || []), ...(n.shadowRoots || [])].map(textOf).join('');
}
function walk(n, fn) {
  fn(n);
  for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, fn);
}

/** Center of the first element with `cls` (and containing `text`), or null. */
async function find(page, cls, text) {
  const { s, doc } = await snapshot(page);
  let hit = null;
  walk(doc, (n) => {
    if (!hit && n.nodeType === 1 && classOf(n).split(/\s+/).includes(cls) && (!text || textOf(n).includes(text))) hit = n;
  });
  let box = null;
  if (hit) {
    try {
      const { model } = await s.send('DOM.getBoxModel', { backendNodeId: hit.backendNodeId });
      const q = model.border;
      box = { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2, w: model.width, h: model.height };
    } catch {
      box = null; // not rendered
    }
  }
  await s.detach();
  return box && box.w > 0 && box.h > 0 ? box : null;
}

async function waitFind(page, cls, text, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const b = await find(page, cls, text);
    if (b) return b;
    await page.waitForTimeout(150);
  }
  throw new Error(`Not found: .${cls}${text ? ` “${text}”` : ''}`);
}

async function gone(page, cls, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!(await find(page, cls))) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function click(page, cls, text) {
  const b = await waitFind(page, cls, text);
  await page.mouse.click(b.x, b.y);
}

async function openMenuItem(page, label) {
  await click(page, 'menu-btn');
  await waitFind(page, 'menu');
  const { s, doc } = await snapshot(page);
  let item = null;
  walk(doc, (n) => {
    if (!item && n.nodeName === 'BUTTON' && n.attributes?.includes('menuitem') && textOf(n).includes(label)) item = n;
  });
  const { model } = await s.send('DOM.getBoxModel', { backendNodeId: item.backendNodeId });
  await s.detach();
  // Before the fix, the page-level "click outside" listener removed the menu
  // on pointerdown, so this click never reached the item.
  await page.mouse.click((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2);
}

const composer = (page) => page.locator('textarea').inputValue();

async function settle(dest) {
  await dest.waitForLoadState('domcontentloaded');
  await dest.waitForTimeout(800);
  if (!(await dest.evaluate(() => !!document.querySelector('textarea, .ProseMirror')).catch(() => false))) {
    const u = new URL(dest.url());
    await dest.goto(`${u.origin}${u.pathname}`);
  }
  return dest;
}

/* ── suite ────────────────────────────────────────────────────────────── */

async function suite(round) {
  const tag = ROUNDS > 1 ? ` [round ${round}]` : '';

  // 1. Closed root + launcher on an empty chat
  {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/');
    const b = await waitFind(page, 'launcher');
    const { s, doc } = await snapshot(page);
    let type = '';
    walk(doc, (n) => {
      if (n.nodeName === 'CONTEXTPORT-UI') type = n.shadowRoots?.[0]?.shadowRootType || '';
    });
    await s.detach();
    check(`UI uses a closed shadow root${tag}`, type === 'closed', type);
    check(`Launcher visible on an empty chat${tag}`, !!b);

    // Menu items, clicked with the mouse
    await openMenuItem(page, 'Insert my About me card');
    await page.waitForFunction(() => document.querySelector('textarea').value.includes('About me:'), null, { timeout: 5000 }).catch(() => {});
    check(`Menu → Insert my About me card works${tag}`, (await composer(page)).includes('I build invoicing tools'));
    check(`Menu closes after choosing an item${tag}`, await gone(page, 'menu'));

    await page.locator('textarea').fill('');
    await openMenuItem(page, 'Insert a snippet');
    await click(page, 'p-name', 'Explain simply');
    await page.waitForTimeout(300);
    check(`Menu → Insert a snippet works${tag}`, (await composer(page)).includes('Explain this like I am new'));

    await click(page, 'menu-btn');
    await waitFind(page, 'menu');
    await page.mouse.click(300, 300); // somewhere on the page
    check(`Clicking the page closes the menu${tag}`, await gone(page, 'menu'));

    // Chrome opens the side panel when it accepts the click as a user gesture,
    // otherwise the Library opens in a tab. Either counts.
    const [lib] = await Promise.all([ctx.waitForEvent('page', { timeout: 4000 }).catch(() => null), openMenuItem(page, 'Open Library')]);
    const panels = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((c) => c.documentUrl));
    const opened = (lib && /sidepanel\.html/.test(lib.url())) || panels.some((u) => /sidepanel\.html/.test(u));
    check(`Menu → Open Library opens the Library${tag}`, opened, lib ? 'in a tab' : panels.length ? 'in the side panel' : 'nothing opened');
    await lib?.close();
    await page.close();
  }

  // 2. Continue in another AI (Claude → ChatGPT), all by mouse
  {
    const page = await ctx.newPage();
    await page.goto('https://claude.ai/chat/closed');
    await waitFind(page, 'launcher');
    await openMenuItem(page, 'Continue in another AI');
    await waitFind(page, 'sheet');
    await click(page, 'dest', 'ChatGPT');
    await waitFind(page, 'card-head', null, 90_000);
    await waitFind(page, 'feedback', null, 90_000); // brief rendered
    const [dest] = await Promise.all([ctx.waitForEvent('page', { timeout: 20_000 }), click(page, 'primary', 'Open in ChatGPT')]);
    await settle(dest);
    await dest.waitForFunction(() => (document.querySelector('textarea')?.value || '').includes('continuing work I started in Claude'), null, { timeout: 30_000 }).catch(() => {});
    const text = await composer(dest);
    check(`Menu → Continue in another AI delivers the brief${tag}`, text.includes('continuing work I started in Claude'), `${text.length} chars`);
    await dest.close();
    check(`Sheet closes itself after sending and the launcher comes back${tag}`, (await gone(page, 'sheet', 8000)) && !!(await waitFind(page, 'menu-btn')));

    // Fresh chat with context
    await openMenuItem(page, 'Fresh Claude chat with context');
    await waitFind(page, 'title', 'Start fresh');
    check(`Menu → Fresh chat opens the fresh-chat sheet${tag}`, true);
    await page.keyboard.press('Escape');
    check(`Escape closes the sheet${tag}`, await gone(page, 'sheet'));
    await page.close();
  }

  // 3. Insert a saved brief into an empty chat
  {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/');
    await waitFind(page, 'launcher');
    await click(page, 'launcher');
    await click(page, 'rb-item');
    await page.waitForFunction(() => document.querySelector('textarea').value.length > 200, null, { timeout: 8000 }).catch(() => {});
    const text = await composer(page);
    check(`Transfer on an empty chat → saved brief inserted${tag}`, text.length > 200 && (await gone(page, 'sheet')), `${text.length} chars`);
    await page.screenshot({ path: path.join(artifacts, `c1-inserted${round}.png`) });
    await page.close();
  }

  // 4. No jank on a very long chat
  {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__lt = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ type: 'longtask', buffered: true });
    });
    await page.goto('https://chatgpt.com/c/heavy');
    await waitFind(page, 'launcher');
    await page.waitForTimeout(2500); // let load work finish
    await page.evaluate(() => (window.__lt = []));
    await page.locator('textarea').click();
    await page.keyboard.type('Can you also add a CSV export with the same totals and a header row?', { delay: 25 });
    for (let i = 0; i < 40; i++) await page.mouse.move(400 + (i % 10) * 30, 150 + i * 15);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, -900);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(6500); // let throttled checks run
    const lt = await page.evaluate(() => window.__lt);
    const worst = Math.max(0, ...lt);
    const total = lt.reduce((a, b) => a + b, 0);
    check(`Long chat: no main-thread stalls while typing/scrolling${tag}`, worst < 150 && total < 600, `${lt.length} long tasks · worst ${Math.round(worst)} ms · total ${Math.round(total)} ms`);
    // Calibration: a deliberate 120 ms block must be seen, so "0" above is real.
    await page.evaluate(() => setTimeout(() => {
      const t = performance.now();
      while (performance.now() - t < 120);
    }));
    await page.waitForTimeout(400);
    const seen = await page.evaluate(() => window.__lt.length);
    check(`Stall detector works (sanity check)${tag}`, seen > lt.length, `${seen - lt.length} long task seen`);
    await page.close();
  }
}

try {
  for (let r = 1; r <= ROUNDS; r++) await suite(r);
} catch (err) {
  check('Suite ran to completion', false, err.message.split('\n')[0]);
}

await ctx.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed.`);
process.exit(passed === results.length ? 0 : 1);
