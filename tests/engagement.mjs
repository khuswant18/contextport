/**
 * Engagement features, end to end, in real Chromium with the built extension.
 * AI sites are served from fixtures with their real DOM selectors, so this
 * suite runs headless and doesn't depend on bot checks or logins.
 *
 *   npm --prefix server start      # server on :8787 (with ADMIN_TOKEN set to check events)
 *   node tests/engagement.mjs
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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

execSync('node extension/build.mjs', { cwd: root, env: { ...process.env, CONTEXTPORT_TEST_BUILD: '1' }, stdio: 'ignore' });
if (!(await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false))) {
  console.error('Start the server first: npm --prefix server start');
  process.exit(1);
}

const ext = path.join(root, 'extension/dist-test');
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: process.env.HEADED !== '1',
  viewport: { width: 1360, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  permissions: ['clipboard-read', 'clipboard-write'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

// Long chat for the nudge test: 42 messages.
const longChat = Array.from({ length: 42 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i}: ${'details '.repeat(20)}` }));

await ctx.route('https://claude.ai/**', (r) => {
  if (r.request().resourceType() !== 'document') return r.abort();
  const p = new URL(r.request().url()).pathname;
  return r.fulfill({ contentType: 'text/html', body: claudePage(p.startsWith('/chat/') ? conversation : [], 'Invoice app') });
});
await ctx.route('https://chatgpt.com/**', (r) => {
  if (r.request().resourceType() !== 'document') return r.abort();
  const p = new URL(r.request().url()).pathname;
  const body = p.startsWith('/c/long') ? chatgptPage(longChat) : p.startsWith('/c/') ? chatgptPage(conversation) : chatgptPage([]);
  return r.fulfill({ contentType: 'text/html', body });
});

const ui = (page) => page.locator('contextport-ui');
const sheet = (page) => ui(page).locator('.sheet');
const waitBrief = (page) => ui(page).locator('.preview h3').waitFor({ timeout: 90_000 });
const swEval = (fn, arg) => sw.evaluate(fn, arg);

async function openFromDestination(page, clickPrimary = true) {
  const [dest] = await Promise.all([ctx.waitForEvent('page', { timeout: 20_000 }), clickPrimary ? ui(page).locator('.foot .btn.primary').click() : null]);
  return settle(dest);
}

async function settle(dest) {
  await dest.waitForLoadState('domcontentloaded');
  // Tabs opened by the extension can load before Playwright's routing attaches
  // (the real site then shows a bot check). The hand-off stays queued until a
  // message box appears, so reloading onto the fixture completes it.
  await dest.waitForTimeout(800);
  const isFixture = await dest.evaluate(() => !!document.querySelector('textarea, .ProseMirror')).catch(() => false);
  if (!isFixture) {
    const u = new URL(dest.url());
    await dest.goto(`${u.origin}${u.pathname}`);
  }
  return dest;
}

try {
  /* 1. Launcher, menu & first-run coachmark */
  {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/c/demo');
    await ui(page).locator('.launcher.on').waitFor({ timeout: 20_000 });
    check('Coachmark shows on first visit', await ui(page).locator('.coach').waitFor({ timeout: 5000 }).then(() => true, () => false));
    await ui(page).locator('.coach button').click();
    await ui(page).locator('.menu-btn').click();
    const items = await ui(page).locator('.menu button').allInnerTexts();
    check('Quick menu lists the daily actions', items.length === 6 && items.some((t) => /saved brief/i.test(t)) && items.some((t) => /snippet/i.test(t)) && !items.some((t) => /second opinion/i.test(t)), items.map((t) => t.split('\n')[0]).join(' · '));
    await page.screenshot({ path: path.join(artifacts, 'e1-menu.png') });
    await page.keyboard.press('Escape');
    const seen = await swEval(async () => (await chrome.storage.local.get('seen')).seen);
    check('Coachmark is only shown once', !!seen?.tip_launcher);
    await page.close();
  }

  /* 2. Empty chat: the launcher is still there and offers saved briefs */
  {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/');
    await ui(page).locator('.launcher.on').waitFor({ timeout: 20_000 });
    check('Launcher shows on an empty chat', await ui(page).locator('.launcher.on').isVisible());
    await ui(page).locator('.launcher').click();
    await ui(page).locator('.rb-list:not([aria-busy])').waitFor({ timeout: 10_000 });
    const title = await ui(page).locator('.sheet .title').innerText();
    check('Empty chat opens “Bring in a saved brief”', /saved brief/i.test(title), title);
    check('No reply hover buttons are drawn', (await ui(page).locator('.hover-group, .hover-btn').count()) === 0);
    await page.keyboard.press('Escape');
    await page.close();
  }

  /* 4. More options: short brief, new project, About me; save + share */
  await swEval(() => chrome.storage.local.set({ aboutMe: 'I am a solo founder in Bangalore. Prefer concise answers with code first.' }));
  let shareUrl = '';
  {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/c/options');
    await ui(page).locator('.launcher.on').waitFor({ timeout: 20_000 });
    await ui(page).locator('.launcher').click();
    await waitBrief(page);
    await ui(page).locator('.more-toggle').click();
    await ui(page).locator('.opt-row .switch').click();
    await ui(page).locator('.opt-row select').selectOption('__new');
    await ui(page).locator('.inline-new input').fill('Invoice SaaS');
    await ui(page).locator('.inline-new button').click();
    const projVal = await ui(page).locator('.opt-row select').inputValue();
    check('Project created inline and selected', !!projVal && projVal !== '__new');
    await ui(page).locator('.opt-row .seg [data-v="short"]').click();
    await waitBrief(page);
    await ui(page).locator('.link', { hasText: 'Edit text' }).click();
    const text = await ui(page).locator('.editor').inputValue();
    check('About me card added to the brief', /(## About me|<about_me>)\nI am a solo founder/.test(text), text.slice(0, 160).replace(/\n/g, '⏎'));
    await ui(page).locator('.link', { hasText: 'Preview' }).click();

    // Rate: thumbs down + reason
    await ui(page).locator('.thumb[aria-label="Needs work"]').click();
    await ui(page).locator('.feedback .pick', { hasText: 'Missing code' }).click();
    await ui(page).locator('.feedback .link', { hasText: 'Send' }).click();
    check('Brief rating recorded', await ui(page).locator('.feedback.thanks').isVisible());

    await ui(page).locator('.foot [aria-label="Save to Library"]').click();
    await page.waitForTimeout(500);
    await ui(page).locator('.foot [aria-label="Create a share link"]').click();
    await ui(page).locator('.toast', { hasText: 'Share link copied' }).waitFor({ timeout: 20_000 });
    shareUrl = await page.evaluate(() => navigator.clipboard.readText());
    check('Encrypted share link created', /^http:\/\/localhost:8787\/s\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/.test(shareUrl), shareUrl.replace(/#.*/, '#<key>'));
    await page.screenshot({ path: path.join(artifacts, 'e4-options.png') });
    await page.close();
  }

  /* 5. Share page decrypts in the browser; server holds only ciphertext */
  {
    const page = await ctx.newPage();
    await page.goto(shareUrl);
    await page.locator('.brief h3').waitFor({ timeout: 15_000 });
    const body = await page.locator('.brief').innerText();
    check('Share page decrypts and shows the brief', /Goal|GOAL/.test(body) && body.length > 100);
    await page.screenshot({ path: path.join(artifacts, 'e5-share-page.png'), fullPage: true });
    const id = shareUrl.split('/s/')[1].split('#')[0];
    const raw = await (await fetch(`${API}/api/v1/shares/${id}`)).json();
    check('Server response is ciphertext only', !JSON.stringify(raw).toLowerCase().includes('invoice'));
    await page.goto(shareUrl.split('#')[0]);
    await page.locator('.card p').first().waitFor();
    check('Link without the key can’t be read', /missing its key/.test(await page.locator('.card p').first().innerText()));
    await page.close();
  }

  /* 6. Library: saved checkpoint, project, revoke link, continue project */
  {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await page.locator('.tabs [role="tab"]', { hasText: 'Saved' }).click();
    await page.locator('.item').first().waitFor({ timeout: 10_000 });
    const savedTitle = await page.locator('.item .t').first().innerText();
    check('Checkpoint appears under Saved', !!savedTitle, savedTitle);
    await page.locator('.item').first().click();
    await page.locator('.share-row input').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'e6-library-detail.png'), fullPage: true });
    await page.locator('.linkish', { hasText: 'Revoke link' }).click();
    await page.locator('.notice', { hasText: 'revoked' }).waitFor();
    const id = shareUrl.split('/s/')[1].split('#')[0];
    check('Revoked link stops working', (await fetch(`${API}/api/v1/shares/${id}`)).status === 404);
    await page.locator('.btn', { hasText: 'Library' }).click();
    await page.locator('.tabs [role="tab"]', { hasText: 'Projects' }).click();
    await page.locator('.item', { hasText: 'Invoice SaaS' }).click();
    await page.locator('.project-cta').waitFor();
    await page.locator('.project-cta select').selectOption('claude');
    const [opened] = await Promise.all([ctx.waitForEvent('page'), page.locator('.project-cta .btn.primary').click()]);
    const dest = await settle(opened);
    await dest.waitForFunction(() => document.querySelector('.ProseMirror')?.innerText.includes('<handoff>'), null, { timeout: 30_000 });
    check('Continue project opens the latest brief in the chosen AI', true);
    await page.screenshot({ path: path.join(artifacts, 'e7-project.png'), fullPage: true });
    await dest.close();
    await page.close();
  }

  /* 6b. Bring a saved brief into an empty chat */
  {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/');
    await ui(page).locator('.launcher.on').waitFor({ timeout: 20_000 });
    await ui(page).locator('.menu-btn').click();
    await ui(page).locator('.menu button', { hasText: 'Insert a saved brief' }).click();
    await ui(page).locator('.rb-item').first().waitFor({ timeout: 10_000 });
    const n = await ui(page).locator('.rb-item').count();
    await ui(page).locator('.rb-item').first().click();
    await page.waitForFunction(() => (document.querySelector('textarea')?.value || '').length > 200, null, { timeout: 10_000 });
    const closed = await ui(page).locator('.sheet').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
    const text = await page.locator('textarea').inputValue();
    check('Saved brief inserted into the empty chat', /## Goal|continuing work/i.test(text) && closed, `${n} briefs listed · ${text.length} chars`);
    await page.screenshot({ path: path.join(artifacts, 'e2-insert-saved.png') });
    await page.close();
  }

  /* 7. Usage-limit rescue */
  {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/c/limit');
    await ui(page).locator('.launcher.on').waitFor({ timeout: 20_000 });
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.setAttribute('role', 'alert');
      d.textContent = "You've reached your message limit. Try again after 5:30 PM.";
      document.body.append(d);
    });
    await ui(page).locator('.banner').waitFor({ timeout: 10_000 });
    const t = await ui(page).locator('.banner').innerText();
    check('Limit notice triggers a “continue elsewhere” banner', /Hit ChatGPT's limit/.test(t) && /Continue in Claude/.test(t));
    await page.screenshot({ path: path.join(artifacts, 'e8-limit-banner.png') });
    await ui(page).locator('.banner .btn', { hasText: 'Continue in Gemini' }).click();
    await sheet(page).waitFor();
    check('Banner opens the panel with that destination', (await ui(page).locator('.dest[data-v="gemini"]').getAttribute('aria-checked')) === 'true');
    await page.close();
  }

  /* 8. Long-chat nudge -> fresh chat on the same AI */
  {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/c/long');
    await ui(page).locator('.banner').waitFor({ timeout: 15_000 });
    check('Long chat suggests starting fresh', /getting long/.test(await ui(page).locator('.banner').innerText()));
    await ui(page).locator('.banner .btn.primary').click();
    await sheet(page).waitFor();
    check('Fresh-chat mode targets the same AI', (await ui(page).locator('.dest[data-v="chatgpt"]').getAttribute('aria-checked')) === 'true');
    await waitBrief(page);
    const dest = await openFromDestination(page);
    await dest.waitForFunction(() => document.querySelector('textarea')?.value.includes('continuing work I started in ChatGPT'), null, { timeout: 30_000 });
    check('Fresh ChatGPT chat receives the brief', new URL(dest.url()).pathname === '/');
    await dest.close();
    await page.close();
  }

  /* 9. Snippets: “//” picker in the message box */
  {
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/');
    await page.locator('textarea').click();
    await page.keyboard.type('Please help. //conc');
    await ui(page).locator('.picker').waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(artifacts, 'e9-snippets.png') });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const v = await page.locator('textarea').inputValue();
    check('Snippet inserted and trigger removed', v === 'Please help. Answer concisely. Use short bullet points and skip the preamble.', JSON.stringify(v));
    // Same on a ProseMirror editor (Claude)
    await page.goto('https://claude.ai/new');
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('//step');
    await ui(page).locator('.picker').waitFor({ timeout: 5000 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const pm = await page.locator('.ProseMirror').innerText();
    check('Snippet works in rich editors too', /step by step/.test(pm) && !pm.includes('//'), JSON.stringify(pm.slice(0, 60)));
    await page.close();
  }

  /* 10. Review request after the 3rd successful transfer */
  {
    await swEval(() => chrome.storage.local.get('stats').then(({ stats }) => chrome.storage.local.set({ stats: { ...(stats || {}), delivered: 3, reviewAsked: false } })));
    const page = await ctx.newPage();
    await page.goto('https://claude.ai/chat/rate');
    await ui(page).locator('.launcher.on').waitFor({ timeout: 20_000 });
    await ui(page).locator('.launcher').click();
    await waitBrief(page);
    const dest = await openFromDestination(page);
    await ui(dest).locator('.toast', { hasText: 'Enjoying ContextPort' }).waitFor({ timeout: 30_000 });
    check('Asks for a store rating once, at a success moment', await ui(dest).locator('.toast .tbtn', { hasText: 'Rate it' }).isVisible());
    await dest.close();
    await page.close();
  }

  /* 11. Popup: what's new, time saved, quick actions, invite */
  {
    await swEval(() => chrome.storage.local.set({ whatsNew: { version: '3.3.0', seen: false } }));
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto(`chrome-extension://${extId}/popup/popup.html`);
    await page.locator('.hero h1').waitFor();
    check('Popup shows what’s new once', await page.locator('.wn').isVisible());
    const value = await page.locator('.value').innerText().catch(() => '');
    check('Popup shows time saved this month', /Saved you about \d+/.test(value), value);
    check('Popup offers invites', await page.locator('.invite').isVisible());
    await page.screenshot({ path: path.join(artifacts, 'e10-popup.png'), fullPage: true });
    await page.close();
  }

  /* 12. Welcome page demo + invite code */
  {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/options/options.html#welcome`);
    await page.locator('.welcome .btn.primary').click();
    await page.locator('.demo-out .brief h3').waitFor({ timeout: 60_000 });
    const demo = await page.locator('.demo-out').innerText();
    check('Welcome demo writes a real brief of a sample chat', /Lisbon|Graça|vegetarian/i.test(demo));
    await page.screenshot({ path: path.join(artifacts, 'e11-welcome.png'), fullPage: true });
    await page.locator('.invite-card .code').waitFor({ timeout: 15_000 });
    const code = await page.locator('.invite-card .code').innerText();
    check('Invite code shown', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), code);
    await page.locator('.invite-card .key-row input').fill(code);
    await page.locator('.invite-card .key-row button').click();
    await page.locator('.invite-card .notice').waitFor();
    check('Own invite code is refused', /own invite code/.test(await page.locator('.invite-card .notice').innerText()));
    await page.close();
  }

  /* 13. Anonymous events reach the server (no content) */
  {
    await swEval(async () => {
      const { eventQueue = [] } = await chrome.storage.local.get('eventQueue');
      await chrome.storage.local.set({ lastFlush: 0, eventQueue });
    });
    await swEval(() => chrome.runtime.getManifest()); // keep SW alive
    const queued = await swEval(async () => (await chrome.storage.local.get('eventQueue')).eventQueue?.length || 0);
    // trigger one more event to force a flush
    const page = await ctx.newPage();
    await page.goto('https://chatgpt.com/c/flush');
    await ui(page).locator('.launcher.on').waitFor({ timeout: 20_000 });
    await ui(page).locator('.launcher').click();
    await sheet(page).waitFor();
    await page.waitForTimeout(3000);
    const left = await swEval(async () => (await chrome.storage.local.get('eventQueue')).eventQueue?.length || 0);
    check('Usage events are batched and delivered', left < queued + 1, `queued ${queued} → ${left}`);
    const sample = await swEval(async () => JSON.stringify((await chrome.storage.local.get('eventQueue')).eventQueue || []));
    check('Queued events contain no conversation text', !/invoice|paise|Lisbon/i.test(sample));
    await page.close();
  }
} catch (err) {
  check('Suite crashed', false, err.message.split('\n')[0]);
}

await ctx.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots in tests/artifacts/`);
process.exit(failed ? 1 : 0);
