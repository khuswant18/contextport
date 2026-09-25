/**
 * Generates Chrome Web Store listing assets from the real extension:
 *   store-assets/screenshot-1..5.png   1280×800
 *   store-assets/promo-small.png       440×280
 *   store-assets/promo-marquee.png     1400×560
 *   store-assets/demo.webm             ~20s walkthrough (upload to YouTube for the listing video)
 *
 * Requires the server on :8787.   Run: node tools/store-assets.mjs
 */

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudePage } from '../tests/fixtures/claude-page.mjs';
import { chatgptPage } from '../tests/fixtures/chatgpt-page.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'store-assets');
fs.mkdirSync(out, { recursive: true });
const conversation = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/conversation.json'), 'utf8'));
execSync('node extension/build.mjs', { cwd: root, env: { ...process.env, CONTEXTPORT_TEST_BUILD: '1' }, stdio: 'ignore' });
const ext = path.join(root, 'extension/dist-test');
const size = { width: 1280, height: 800 };

async function launch(video) {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: size,
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    ...(video ? { recordVideo: { dir: out, size } } : {}),
  });
  await ctx.route('https://claude.ai/**', (r) => (r.request().resourceType() === 'document' ? r.fulfill({ contentType: 'text/html', body: claudePage(new URL(r.request().url()).pathname.startsWith('/chat/') ? conversation : []) }) : r.abort()));
  await ctx.route('https://chatgpt.com/**', (r) => (r.request().resourceType() === 'document' ? r.fulfill({ contentType: 'text/html', body: chatgptPage(new URL(r.request().url()).pathname.startsWith('/c/') ? conversation : []) }) : r.abort()));
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ seen: { tip_launcher: Date.now() } }));
  return { ctx, sw, extId: new URL(sw.url()).host };
}

const ui = (p) => p.locator('contextport-ui');

/* ── screenshots ───────────────────────────────────────────────────── */
{
  const { ctx, extId } = await launch(false);
  const p = await ctx.newPage();

  await p.goto('https://chatgpt.com/c/shot');
  await ui(p).locator('.launcher.on').click();
  await ui(p).locator('.preview h3').waitFor({ timeout: 90_000 });
  await p.screenshot({ path: path.join(out, 'screenshot-1.png') });

  await ui(p).locator('.seg.purpose [data-v="review"]').click();
  await ui(p).locator('.pick', { hasText: 'Fact-check' }).click();
  await ui(p).locator('.preview h3').waitFor({ timeout: 90_000 });
  await p.screenshot({ path: path.join(out, 'screenshot-2.png') });
  await ui(p).locator('.close').click();

  await p.evaluate(() => {
    const d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.textContent = "You've reached your message limit. Try again after 5:30 PM.";
    document.body.append(d);
  });
  await ui(p).locator('.banner').waitFor({ timeout: 10_000 });
  await p.screenshot({ path: path.join(out, 'screenshot-3.png') });

  await p.goto('https://claude.ai/chat/shot');
  await ui(p).locator('.launcher.on').click();
  await ui(p).locator('.preview h3').waitFor({ timeout: 90_000 });
  await ui(p).locator('.foot [aria-label="Save to Library"]').click();
  await p.waitForTimeout(400);
  const lib = await ctx.newPage();
  await lib.setViewportSize({ width: 420, height: 800 });
  await lib.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  await lib.locator('.item').first().click();
  await lib.locator('.detail .card').waitFor();
  const libShot = await lib.screenshot();
  await p.setContent(`<html><body style="margin:0;background:#f5f5f5;display:flex;align-items:center;gap:64px;padding:0 90px;font-family:Georgia,serif;height:800px">
    <div style="flex:1"><div style="font:600 13px system-ui;letter-spacing:1px;color:#777169;text-transform:uppercase">Library</div>
    <h1 style="font-weight:300;font-size:52px;line-height:1.08;margin:12px 0;color:#0c0a09">Save, resume and share every brief</h1>
    <p style="font:18px/1.5 system-ui;color:#4e4e4e">Checkpoints, projects, Markdown &amp; Obsidian export, and end-to-end encrypted share links — all stored on your device.</p></div>
    <img src="data:image/png;base64,${libShot.toString('base64')}" style="height:760px;border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.18)"></body></html>`);
  await p.screenshot({ path: path.join(out, 'screenshot-4.png') });

  await p.goto(`chrome-extension://${extId}/options/options.html#engine`);
  await p.locator('.engine').nth(1).click();
  await p.locator('#provider').waitFor();
  await p.evaluate(() => document.getElementById('engine').scrollIntoView());
  await p.screenshot({ path: path.join(out, 'screenshot-5.png') });
  await ctx.close();
}

/* ── promo tiles ───────────────────────────────────────────────────── */
{
  const b = await chromium.launch();
  const p = await b.newPage();
  const icon = fs.readFileSync(path.join(root, 'site/public/favicon.svg'), 'utf8');
  const tile = (w, h, title, sub) => `<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#f5f5f5;position:relative;font-family:Georgia,serif">
    <div style="position:absolute;width:${w * 0.8}px;height:${w * 0.8}px;right:-${w * 0.2}px;top:-${w * 0.35}px;border-radius:50%;filter:blur(20px);opacity:.75;background:radial-gradient(circle at 40% 45%,#a7e5d3,transparent 62%),radial-gradient(circle at 70% 60%,#c8b8e0,transparent 58%),radial-gradient(circle at 30% 80%,#f4c5a8,transparent 50%)"></div>
    <div style="position:absolute;left:${w * 0.07}px;top:50%;transform:translateY(-50%);max-width:${w * 0.75}px">
      <div style="width:${h * 0.18}px;height:${h * 0.18}px">${icon.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
      <div style="font-weight:300;font-size:${h * 0.15}px;line-height:1.05;color:#0c0a09;margin-top:${h * 0.05}px;letter-spacing:-1px">${title}</div>
      <div style="font:${h * 0.06}px/1.4 system-ui;color:#4e4e4e;margin-top:${h * 0.04}px">${sub}</div>
    </div></body></html>`;
  await p.setViewportSize({ width: 440, height: 280 });
  await p.setContent(tile(440, 280, 'Move any AI chat.', 'ChatGPT · Claude · Gemini — keep every detail'));
  await p.screenshot({ path: path.join(out, 'promo-small.png') });
  await p.setViewportSize({ width: 1400, height: 560 });
  await p.setContent(tile(1400, 560, 'Move any AI chat. Keep every detail.', 'Transfer, second opinions and briefs across ChatGPT, Claude and Gemini'));
  await p.screenshot({ path: path.join(out, 'promo-marquee.png') });
  await b.close();
}

/* ── demo video ────────────────────────────────────────────────────── */
{
  const { ctx } = await launch(true);
  const p = await ctx.newPage();
  await p.goto('https://chatgpt.com/c/demo');
  await p.waitForTimeout(1200);
  await ui(p).locator('.launcher.on').hover();
  await p.waitForTimeout(600);
  await ui(p).locator('.launcher.on').click();
  await ui(p).locator('.preview h3').waitFor({ timeout: 90_000 });
  await p.waitForTimeout(2500);
  await ui(p).locator('.preview').evaluate((el) => el.scrollBy({ top: 400, behavior: 'smooth' }));
  await p.waitForTimeout(2000);
  const [dest] = await Promise.all([ctx.waitForEvent('page'), ui(p).locator('.foot .btn.primary').click()]);
  await p.waitForTimeout(1500);
  await dest.waitForTimeout(800);
  if (!(await dest.locator('.ProseMirror').count())) await dest.goto('https://claude.ai/new');
  await dest.waitForFunction(() => document.querySelector('.ProseMirror')?.innerText.includes('<handoff>'), null, { timeout: 30_000 });
  await dest.waitForTimeout(3500);
  const videoPath = await dest.video().path();
  const srcVideo = await p.video().path();
  await ctx.close();
  // Two tabs record separately; keep the source-tab clip (panel flow) and the destination clip.
  fs.renameSync(srcVideo, path.join(out, 'demo-transfer.webm'));
  fs.renameSync(videoPath, path.join(out, 'demo-destination.webm'));
  for (const f of fs.readdirSync(out)) if (f.endsWith('.webm') && !f.startsWith('demo-')) fs.rmSync(path.join(out, f));
}

console.log(`Store assets written to ${out}`);
for (const f of fs.readdirSync(out)) console.log(' -', f, `${Math.round(fs.statSync(path.join(out, f)).size / 1024)} KB`);
