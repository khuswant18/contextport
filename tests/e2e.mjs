/**
 * End-to-end tests: real Chromium + the built extension + the local server.
 *
 *   npm --prefix server start          # in one terminal
 *   node tests/e2e.mjs                 # in another
 *
 * ChatGPT and Gemini are tested live (logged-out chat). claude.ai requires a
 * login, so it is served from a fixture with the same DOM selectors.
 */

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudePage } from './fixtures/claude-page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const extDir = path.join(root, 'extension/dist-test');
const artifacts = path.join(here, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const conversation = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/conversation.json'), 'utf8'));
const only = process.argv.slice(2);

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

execSync('node extension/build.mjs', { cwd: root, env: { ...process.env, CONTEXTPORT_TEST_BUILD: '1' }, stdio: 'ignore' });
const health = await fetch('http://localhost:8787/api/health').then((r) => r.ok).catch(() => false);
if (!health) {
  console.error('Server is not running on http://localhost:8787 — start it with: npm --prefix server start');
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  // ChatGPT's bot check blocks headless browsers, so the live tests run headed by default.
  headless: process.env.HEADLESS === '1',
  viewport: { width: 1360, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
  permissions: ['clipboard-read', 'clipboard-write'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

// claude.ai -> fixture pages
await ctx.route('https://claude.ai/**', (route) => {
  const url = new URL(route.request().url());
  if (route.request().resourceType() !== 'document') return route.abort();
  const body = url.pathname.startsWith('/chat/') ? claudePage(conversation, 'Invoice app on Vercel') : claudePage([]);
  return route.fulfill({ status: 200, contentType: 'text/html', body });
});

const ui = (page) => page.locator('contextport-ui');

async function openSheetViaLauncher(page) {
  const launcher = ui(page).locator('.launcher.on');
  await launcher.waitFor({ timeout: 30_000 });
  await launcher.click();
  await ui(page).locator('.sheet').waitFor();
}

async function waitForBrief(page) {
  await ui(page).locator('.preview h3').waitFor({ timeout: 90_000 });
  return ui(page).locator('.preview').innerText();
}

async function sendTo(page, dest) {
  await ui(page).locator(`.dest[data-v="${dest}"]`).click();
  const [newPage] = await Promise.all([ctx.waitForEvent('page', { timeout: 20_000 }), ui(page).locator('.foot .btn.primary').click()]);
  await ui(page).locator('.done-state').waitFor({ timeout: 10_000 });
  return newPage;
}

async function composerContent(page, selector) {
  return page.locator(selector).first().evaluate((el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText));
}

async function askLive(page, selector, prompt, doneCheck) {
  await page.locator(selector).first().click();
  // Sites restore unsent drafts; start from an empty box.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(prompt);
  await page.keyboard.press('Enter');
  await page.waitForFunction(doneCheck, null, { timeout: 90_000, polling: 1000 });
  await page.waitForTimeout(2500);
}

const run = (name) => only.length === 0 || only.some((o) => name.toLowerCase().includes(o.toLowerCase()));

/* 1. Claude (fixture) -> ChatGPT (live) */
if (run('claude-to-chatgpt')) {
  try {
    const page = await ctx.newPage();
    await page.goto('https://claude.ai/chat/7f3c', { waitUntil: 'domcontentloaded' });
    await openSheetViaLauncher(page);
    const brief = await waitForBrief(page);
    record('Claude → brief generated with ContextPort AI', /paise|GST|pgbouncer/i.test(brief), `${brief.length} chars`);
    const codeCount = await ui(page).locator('.preview pre').count();
    record('Claude → code blocks preserved', codeCount >= 2, `${codeCount} blocks`);
    const engine = await ui(page).locator('.engine span').innerText();
    record('Hosted engine never reveals provider', !/groq|gpt-oss|qwen|llama/i.test(engine + brief), engine);
    await page.screenshot({ path: path.join(artifacts, '1-claude-sheet.png') });

    // Full transcript toggle
    await ui(page).locator('.seg [data-v="full"]').click();
    await ui(page).locator('.preview h4').first().waitFor({ timeout: 20_000 });
    record('Full transcript mode renders', (await ui(page).locator('.preview h4').count()) >= conversation.length);
    await ui(page).locator('.seg [data-v="smart"]').click();
    await waitForBrief(page);

    const dest = await sendTo(page, 'chatgpt');
    dest.on('console', (m) => m.text().includes('ContextPort') && console.log('  [chatgpt]', m.text()));
    globalThis.__dest = dest;
    await dest.waitForLoadState('domcontentloaded');
    await dest.waitForFunction(
      () => {
        const els = [...document.querySelectorAll('textarea, [contenteditable="true"]')];
        return els.some((t) => (t.tagName === 'TEXTAREA' ? t.value : t.innerText).includes('continuing work I started in Claude'));
      },
      null,
      { timeout: 45_000 },
    );
    const text = await dest.evaluate(() =>
      [...document.querySelectorAll('textarea, [contenteditable="true"]')].map((t) => (t.tagName === 'TEXTAREA' ? t.value : t.innerText)).find((v) => v.includes('continuing work')) || '',
    );
    record('ChatGPT (live) → context inserted into composer', text.includes('## Goal') && text.includes('```'), `${text.length} chars`);
    await dest.waitForTimeout(1200);
    await dest.screenshot({ path: path.join(artifacts, '2-chatgpt-destination.png') });
    await dest.close();
    await page.close();
  } catch (err) {
    await globalThis.__dest?.screenshot({ path: path.join(artifacts, 'fail-chatgpt-destination.png') }).catch(() => {});
    record('Claude → ChatGPT flow', false, err.message.split('\n')[0]);
  }
}

/* 2. Gemini (live) -> Claude (fixture) */
if (run('gemini-to-claude')) {
  try {
    const page = await ctx.newPage();
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
    await askLive(
      page,
      'div.ql-editor[contenteditable="true"]',
      'I need a Python function slugify(title) that lowercases, strips accents and joins words with hyphens. Show the code, then one example.',
      () => {
        const r = [...document.querySelectorAll('model-response')].pop();
        return !!(r && r.querySelector('pre') && !r.querySelector('[aria-busy="true"]'));
      },
    );
    await openSheetViaLauncher(page);
    const brief = await waitForBrief(page);
    record('Gemini (live) → brief generated', /slug/i.test(brief), `${brief.length} chars`);
    const pre = await ui(page).locator('.preview pre').first().innerText();
    record('Gemini (live) → exact code extracted', /def slugify/.test(pre));
    await page.screenshot({ path: path.join(artifacts, '3-gemini-sheet.png') });

    const dest = await sendTo(page, 'claude');
    await dest.waitForFunction(() => document.querySelector('.ProseMirror')?.innerText.includes('<handoff>'), null, { timeout: 30_000 });
    const text = await composerContent(dest, '.ProseMirror');
    record('Claude → context inserted with XML sections', text.includes('<goal>') && /def slugify/.test(text), `${text.length} chars`);
    await dest.screenshot({ path: path.join(artifacts, '4-claude-destination.png') });
    await dest.close();
    await page.close();
  } catch (err) {
    for (const p of ctx.pages()) if (/gemini|claude/.test(p.url())) await p.screenshot({ path: path.join(artifacts, `fail-gemini-${Date.now()}.png`) }).catch(() => {});
    record('Gemini → Claude flow', false, err.message.split('\n')[0]);
  }
}

/* 3. ChatGPT (live) -> Gemini (live) */
if (run('chatgpt-to-gemini')) {
  try {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await askLive(
      page,
      'textarea[aria-label="Chat with ChatGPT"], #prompt-textarea',
      'Give me a SQL query that returns the top 3 customers by total order amount from tables customers(id,name) and orders(id,customer_id,amount). Code first, then one sentence.',
      () => {
        const li = [...document.querySelectorAll('li[data-message-role="assistant"]:not([data-conversation-recovery])')].pop();
        const old = [...document.querySelectorAll('[data-message-author-role="assistant"]')].pop();
        return !!((li && li.hasAttribute('data-message-complete') && li.querySelector('pre')) || (old && old.querySelector('pre')));
      },
    );
    await openSheetViaLauncher(page);
    const brief = await waitForBrief(page);
    record('ChatGPT (live) → brief generated', /customer|order/i.test(brief), `${brief.length} chars`);
    const pre = await ui(page).locator('.preview pre').first().innerText().catch(() => '');
    record('ChatGPT (live) → exact SQL extracted', /select/i.test(pre) && /limit 3|top 3|fetch first 3/i.test(pre));
    await page.screenshot({ path: path.join(artifacts, '5-chatgpt-sheet.png') });

    const dest = await sendTo(page, 'gemini');
    await dest.waitForFunction(() => document.querySelector('div.ql-editor[contenteditable="true"]')?.innerText.includes('continuing work I started in ChatGPT'), null, { timeout: 45_000 });
    const text = await composerContent(dest, 'div.ql-editor[contenteditable="true"]');
    record('Gemini (live) → context inserted into composer', /SELECT/i.test(text), `${text.length} chars`);
    await dest.waitForTimeout(800);
    await dest.screenshot({ path: path.join(artifacts, '6-gemini-destination.png') });
    await dest.close();
    await page.close();
  } catch (err) {
    for (const p of ctx.pages()) if (/gemini|chatgpt/.test(p.url())) await p.screenshot({ path: path.join(artifacts, `fail-chatgpt-${Date.now()}.png`) }).catch(() => {});
    record('ChatGPT → Gemini flow', false, err.message.split('\n')[0]);
  }
}

/* 3b. Bring-your-own-key + fallback when a key is rejected */
if (run('byok') && process.env.GROQ_API_KEY) {
  const setEngine = (settings, key) =>
    sw.evaluate(
      async ({ settings, key }) => {
        const cur = (await chrome.storage.local.get('settings')).settings || {};
        await chrome.storage.local.set({ settings: { ...cur, ...settings } });
        await new Promise((resolve, reject) => {
          const req = indexedDB.open('contextport');
          req.onsuccess = () => {
            const tx = req.result.transaction('secrets', 'readwrite');
            tx.objectStore('secrets').put(key, 'key:groq');
            tx.oncomplete = resolve;
            tx.onerror = reject;
          };
          req.onerror = reject;
        });
      },
      { settings, key },
    );
  try {
    await setEngine({ engine: 'byok', provider: 'groq', models: { groq: 'openai/gpt-oss-120b' } }, process.env.GROQ_API_KEY);
    const page = await ctx.newPage();
    await page.goto('https://claude.ai/chat/byok', { waitUntil: 'domcontentloaded' });
    await openSheetViaLauncher(page);
    const brief = await waitForBrief(page);
    const label = await ui(page).locator('.engine span').innerText();
    record('BYOK → brief written with the user’s own key', /Your Groq key/.test(label) && /paise|GST/i.test(brief), label);
    await page.close();

    await setEngine({ engine: 'byok', provider: 'groq' }, 'gsk_invalidinvalidinvalidinvalid');
    const page2 = await ctx.newPage();
    await page2.goto('https://claude.ai/chat/badkey', { waitUntil: 'domcontentloaded' });
    await openSheetViaLauncher(page2);
    await waitForBrief(page2);
    const notice = await ui(page2).locator('.notice').first().innerText();
    record('Rejected key → clear notice + offline brief (no dead end)', /rejected the API key/i.test(notice), notice.slice(0, 90));
    await page2.screenshot({ path: path.join(artifacts, '11-fallback-notice.png') });
    await page2.close();
  } catch (err) {
    record('BYOK flow', false, err.message.split('\n')[0]);
  } finally {
    await setEngine({ engine: 'hosted' }, null).catch(() => {});
  }
}

/* 4. Extension pages */
if (run('pages')) {
  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 360, height: 600 });
    await page.goto(`chrome-extension://${extId}/popup/popup.html`);
    await page.locator('.hero h1').waitFor();
    await page.screenshot({ path: path.join(artifacts, '7-popup.png'), fullPage: true });
    record('Popup renders', true);

    await page.setViewportSize({ width: 400, height: 900 });
    await page.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await page.locator('.list').waitFor();
    const items = await page.locator('.item').count();
    record('Library lists past transfers', items > 0 || only.length > 0, `${items} items`);
    if (items) {
      await page.locator('.item').first().click();
      await page.locator('.detail .card').waitFor();
    }
    await page.screenshot({ path: path.join(artifacts, '8-library.png'), fullPage: true });

    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`chrome-extension://${extId}/options/options.html`);
    await page.locator('.engine').first().waitFor();
    await page.screenshot({ path: path.join(artifacts, '9-settings.png'), fullPage: true });
    // BYOK panel appears
    await page.locator('.engine').nth(1).click();
    await page.locator('#key-input').waitFor();
    await page.screenshot({ path: path.join(artifacts, '10-settings-byok.png'), fullPage: true });
    record('Settings + bring-your-own-key panel render', true);
    await page.close();
  } catch (err) {
    record('Extension pages', false, err.message.split('\n')[0]);
  }
}

/* 5. Security: page scripts can't reach privileged extension APIs */
if (run('security')) {
  try {
    const page = await ctx.newPage();
    await page.goto('https://claude.ai/chat/7f3c', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const probe = await page.evaluate(() => ({
      chromeRuntime: typeof window.chrome?.runtime?.sendMessage,
      canReadExtensionIdb: typeof indexedDB !== 'undefined',
    }));
    // Page-world chrome.runtime.sendMessage requires externally_connectable, which we don't declare.
    const canMessage = await page.evaluate(
      (id) =>
        new Promise((resolve) => {
          try {
            window.chrome.runtime.sendMessage(id, { type: 'GET_SETTINGS' }, (r) => resolve(!!r));
          } catch {
            resolve(false);
          }
          setTimeout(() => resolve(false), 1500);
        }),
      extId,
    );
    record('Web pages cannot message the extension', canMessage === false, JSON.stringify(probe));
    await page.close();
  } catch (err) {
    record('Security probe', false, err.message.split('\n')[0]);
  }
}

await ctx.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: tests/artifacts/`);
process.exit(failed.length ? 1 : 0);
