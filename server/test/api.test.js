/**
 * API security & behaviour tests against a real (test) database.
 * Run: npm test   (uses server/.env)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handle } from '../src/app.js';
import { migrate, query, closeDb } from '../src/db.js';
import { hashToken } from '../src/auth.js';
import { config } from '../src/config.js';

let server;
let base;
const createdTokens = [];

before(async () => {
  await migrate();
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const t of createdTokens) await query('delete from cp_devices where token_hash = $1', [hashToken(t)]);
  // Registrations from the test IP shouldn't block real use on this machine.
  await query(`delete from cp_ip_daily where day = current_date`);
  server.close();
  await closeDb();
});

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

async function register() {
  const r = await fetch(`${base}/api/v1/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: EXT_ORIGIN }, body: '{}' });
  assert.equal(r.status, 201);
  const { token } = await r.json();
  assert.match(token, /^cp_[A-Za-z0-9_-]{43}$/);
  createdTokens.push(token);
  return token;
}

const brief = (token, body, headers = {}) =>
  fetch(`${base}/api/v1/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: EXT_ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('health is public and minimal', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('security headers are set and no CORS is granted', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(`${base}/api/v1/brief`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 403);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('requests from websites are rejected', async () => {
  const r = await fetch(`${base}/api/v1/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('brief requires a valid device token', async () => {
  assert.equal((await brief(null, {})).status, 401);
  assert.equal((await brief('cp_short', {})).status, 401);
  assert.equal((await brief("cp_' OR 1=1 --aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {})).status, 401);
  assert.equal((await brief(`cp_${'A'.repeat(43)}`, {})).status, 401, 'well-formed but unknown token');
});

test('input validation: content type, JSON, size, shape', async () => {
  const token = await register();
  assert.equal((await brief(token, 'x', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await brief(token, '{not json')).status, 400);
  assert.equal((await brief(token, { messages: [{ role: 'user', content: 'hi' }], sourcePlatform: 'evil' })).status, 400);
  assert.equal((await brief(token, { messages: [{ role: 'system', content: 'x' }], sourcePlatform: 'chatgpt' })).status, 400);
  const big = 'x'.repeat(1_600_000);
  const r = await brief(token, { messages: [{ role: 'user', content: big }], sourcePlatform: 'chatgpt' }).catch(() => ({ status: 413 }));
  assert.equal(r.status, 413);
});

test('per-device burst limit returns 429', async () => {
  const token = await register();
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await brief(token, '{bad')).status);
  assert.ok(statuses.includes(429), statuses.join(','));
});

test('daily quota is enforced atomically and reported', async () => {
  const token = await register();
  const dev = await query('select id from cp_devices where token_hash = $1', [hashToken(token)]);
  await query(`insert into cp_usage_daily (device_id, day, requests) values ($1, current_date, $2)`, [dev.rows[0].id, config.deviceDailyRequests]);
  const r = await brief(token, { messages: [{ role: 'user', content: 'hello' }], sourcePlatform: 'chatgpt' });
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.equal(j.code, 'daily_limit');
  const u = await fetch(`${base}/api/v1/usage`, { headers: { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN } });
  assert.deepEqual(await u.json(), { used: config.deviceDailyRequests, limit: config.deviceDailyRequests });
});

test('blocked devices are refused', async () => {
  const token = await register();
  await query('update cp_devices set blocked = true where token_hash = $1', [hashToken(token)]);
  assert.equal((await brief(token, {})).status, 403);
});

test('only a hash of the token is stored', async () => {
  const token = await register();
  const r = await query('select token_hash from cp_devices where token_hash = $1', [hashToken(token)]);
  assert.equal(r.rowCount, 1);
  assert.ok(!r.rows[0].token_hash.toString('utf8').includes(token));
});

test('static files cannot escape the site directory', async () => {
  for (const p of ['/../server/.env', '/..%2f..%2fserver%2f.env', '/%2e%2e/%2e%2e/server/.env', '/assets/../../../etc/passwd']) {
    const r = await fetch(`${base}${p}`);
    const text = await r.text();
    assert.ok(!text.includes('GROQ_API_KEY') && !text.includes('root:'), `leak via ${p}`);
  }
});

test('a real brief never reveals the model provider', { skip: !process.env.RUN_LIVE_MODEL_TEST }, async () => {
  const token = await register();
  const r = await brief(token, {
    messages: [
      { role: 'user', content: 'Help me name my bakery in Pune. It must be short and in English.' },
      { role: 'assistant', content: 'Ideas: Crumb & Co, Rise, Knead.' },
    ],
    sourcePlatform: 'chatgpt',
  });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.doesNotMatch(text, /groq|gpt-oss|qwen|llama|openai\//i);
  assert.match(text, /"processor":"contextport"/);
});

test('a very long conversation is trimmed to fit and still briefed', { skip: !process.env.RUN_LIVE_MODEL_TEST }, async () => {
  const token = await register();
  const messages = [];
  messages.push({ role: 'user', content: 'Goal: migrate our Django 4.2 monolith to FastAPI without downtime. Must keep PostgreSQL 15 and JWT auth.' });
  for (let i = 1; i < 140; i++) {
    messages.push(
      i % 2
        ? { role: 'assistant', content: `Step ${i}: discussion of module ${i} with details. `.repeat(40) }
        : { role: 'user', content: `Follow-up on module ${i - 1}, what about tests? `.repeat(10) },
    );
  }
  messages.push({ role: 'user', content: 'Latest question: how do we run both apps behind nginx during the cutover?' });
  const r = await brief(token, { messages, sourcePlatform: 'claude' });
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json();
  assert.ok(j.stats.omitted > 0, 'older messages were trimmed');
  assert.match(JSON.stringify(j.brief), /FastAPI/);
  assert.match(JSON.stringify(j.brief), /nginx/i, 'the latest question is reflected');
});
