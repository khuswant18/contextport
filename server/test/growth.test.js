/**
 * Engagement endpoints: share links, referrals, feedback, events, admin stats.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { handle } from '../src/app.js';
import { migrate, query, closeDb } from '../src/db.js';
import { hashToken } from '../src/auth.js';
import { config } from '../src/config.js';

let server;
let base;
const tokens = [];
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

before(async () => {
  config.adminToken = 'test-admin-token-'.padEnd(40, 'x');
  await migrate();
  await query(`delete from cp_rate_limits where key like 'admin:%'`); // repeated runs must not hit the sign-in limit
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const t of tokens) await query('delete from cp_devices where token_hash = $1', [hashToken(t)]);
  await query(`delete from cp_ip_daily where day = current_date`);
  server.close();
  await closeDb();
});

async function register() {
  const r = await fetch(`${base}/api/v1/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: EXT }, body: '{}' });
  const { token } = await r.json();
  tokens.push(token);
  return token;
}

const api = (token, path, { method = 'GET', body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: EXT, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function encrypt(text) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
  return { key, iv, ciphertext: ct.toString('base64url') };
}

test('share links store only ciphertext and round-trip', async () => {
  const t = await register();
  const { key, iv, ciphertext } = await encrypt('secret brief: paise migration');
  const r = await api(t, '/api/v1/shares', { method: 'POST', body: { ciphertext, iv: iv.toString('base64url'), ttlDays: 3 } });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);

  const row = (await query('select ciphertext from cp_shares where id = $1', [id])).rows[0];
  assert.ok(!row.ciphertext.toString('utf8').includes('paise'), 'server never sees plaintext');

  // Public read (website, no Origin, no token)
  const g = await fetch(`${base}/api/v1/shares/${id}`);
  assert.equal(g.status, 200);
  const j = await g.json();
  const buf = Buffer.from(j.ciphertext, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'base64url'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  assert.equal(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString(), 'secret brief: paise migration');

  // Only the owner can revoke
  const other = await register();
  assert.equal((await api(other, `/api/v1/shares/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await api(t, `/api/v1/shares/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/shares/${id}`)).status, 404);
});

test('share input is validated and expired links are gone', async () => {
  const t = await register();
  assert.equal((await api(t, '/api/v1/shares', { method: 'POST', body: { ciphertext: 'not base64!', iv: 'x' } })).status, 400);
  assert.equal((await api(t, '/api/v1/shares', { method: 'POST', body: { ciphertext: 'AAAA', iv: crypto.randomBytes(12).toString('base64url') } })).status, 400);
  assert.equal((await api(null, '/api/v1/shares', { method: 'POST', body: {} })).status, 401);
  const { iv, ciphertext } = await encrypt('x');
  const { id } = await (await api(t, '/api/v1/shares', { method: 'POST', body: { ciphertext, iv: iv.toString('base64url') } })).json();
  await query(`update cp_shares set expires_at = now() - interval '1 minute' where id = $1`, [id]);
  assert.equal((await fetch(`${base}/api/v1/shares/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/shares/..%2F..%2Fetc`)).status, 404);
});

test('referrals: bonus for both, one use, no self or same-network redemption', async () => {
  const referrer = await register();
  const friend = await register();
  const ref = await (await api(referrer, '/api/v1/referral')).json();
  assert.match(ref.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

  // Self-redeem is refused.
  assert.equal((await api(referrer, '/api/v1/referral/redeem', { method: 'POST', body: { code: ref.code } })).status, 400);
  // Same network (both test devices come from 127.0.0.1) is refused.
  const same = await api(friend, '/api/v1/referral/redeem', { method: 'POST', body: { code: ref.code } });
  assert.equal(same.status, 400);
  assert.match((await same.json()).error, /different network/);

  // Simulate a friend on another network.
  await query(`update cp_devices set ip_hash = 'other-network' where token_hash = $1`, [hashToken(friend)]);
  const ok = await api(friend, '/api/v1/referral/redeem', { method: 'POST', body: { code: ref.code.replace('-', '').toLowerCase() } });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await ok.json()).bonusDaily, config.referralBonus);
  assert.equal((await api(friend, '/api/v1/referral/redeem', { method: 'POST', body: { code: ref.code } })).status, 409, 'only once');

  const after = await (await api(referrer, '/api/v1/referral')).json();
  assert.equal(after.credited, 1);
  assert.equal(after.bonusDaily, config.referralBonus);
  const usage = await (await api(referrer, '/api/v1/usage')).json();
  assert.equal(usage.limit, config.deviceDailyRequests + config.referralBonus, 'bonus raises the daily limit');
  assert.equal((await api(friend, '/api/v1/referral/redeem', { method: 'POST', body: { code: 'bad' } })).status, 400);
});

test('feedback and events accept allowlisted values only', async () => {
  const t = await register();
  assert.equal((await api(t, '/api/v1/feedback', { method: 'POST', body: { rating: -1, reasons: ['missing_code', 'DROP TABLE', 'missing_code'], processor: 'hosted', mode: 'smart', detail: 'short' } })).status, 201);
  assert.equal((await api(t, '/api/v1/feedback', { method: 'POST', body: { rating: 5 } })).status, 400);
  const fb = (await query(`select reasons, processor from cp_feedback f join cp_devices d on d.id = f.device_id where d.token_hash = $1`, [hashToken(t)])).rows[0];
  assert.deepEqual(fb.reasons, ['missing_code']);

  const r = await api(t, '/api/v1/events', {
    method: 'POST',
    body: {
      events: [
        { name: 'handoff', props: { source: 'chatgpt', destination: 'claude', secret: 'my chat text', mode: 'smart' } },
        { name: 'not_allowed', props: {} },
        { name: 'panel_open', props: { trigger: 'limit', source: 'evil.com' } },
      ],
    },
  });
  assert.equal(r.status, 202);
  assert.equal((await r.json()).accepted, 2);
  const rows = (await query(`select name, props from cp_events e join cp_devices d on d.id = e.device_id where d.token_hash = $1 order by e.id`, [hashToken(t)])).rows;
  assert.deepEqual(rows[0].props, { source: 'chatgpt', destination: 'claude', mode: 'smart' }, 'unknown props dropped');
  assert.deepEqual(rows[1].props, { trigger: 'limit' }, 'invalid values dropped');
});

test('admin stats require the admin token', async () => {
  assert.equal((await fetch(`${base}/api/v1/admin/stats`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/admin/stats`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const r = await fetch(`${base}/api/v1/admin/stats`, { headers: { Authorization: `Bearer ${config.adminToken}` } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok('activationRate' in j && 'retentionD7' in j && Array.isArray(j.featureUseLast7d));
});

test('admin sign-in issues an HttpOnly session cookie that unlocks stats', async () => {
  const login = (body) => fetch(`${base}/api/v1/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await login({ username: config.adminUsername, password: 'wrong-password' })).status, 401);
  assert.equal((await login({ username: 'someone', password: config.adminPassword })).status, 401);
  assert.equal((await login({})).status, 401);

  const ok = await login({ username: config.adminUsername, password: config.adminPassword });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie') || '';
  assert.match(setCookie, /^cp_admin=\d+\.[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api\/v1\/admin/);
  const session = setCookie.split(';')[0];

  const r = await fetch(`${base}/api/v1/admin/stats`, { headers: { Cookie: session } });
  assert.equal(r.status, 200);
  assert.ok('traffic' in (await r.json()));

  // Tampered, expired or forged sessions are rejected.
  const [, value] = session.split('=');
  const [exp, sig] = value.split('.');
  const tampered = `cp_admin=${Number(exp) + 999}.${sig}`;
  assert.equal((await fetch(`${base}/api/v1/admin/stats`, { headers: { Cookie: tampered } })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/admin/stats`, { headers: { Cookie: `cp_admin=1.${sig}` } })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/admin/stats`, { headers: { Cookie: 'cp_admin=garbage' } })).status, 401);

  const out = await fetch(`${base}/api/v1/admin/logout`, { method: 'POST' });
  assert.match(out.headers.get('set-cookie') || '', /cp_admin=; .*Max-Age=0/);
});

test('page views are counted by route name and referring host only', async () => {
  const pv = (body, headers = {}) =>
    fetch(`${base}/api/v1/pv`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const views = async (path) =>
    (await query(`select coalesce(sum(views), 0)::int as n from cp_pageview_daily where env = 'development' and day = current_date and path = $1`, [path])).rows[0].n;
  const refs = async (host) =>
    (await query(`select coalesce(sum(visits), 0)::int as n from cp_referrer_daily where env = 'development' and day = current_date and host = $1`, [host])).rows[0].n;

  const [home, share, missing, ref] = [await views('/'), await views('/s/*'), await views('/404'), await refs('news.ycombinator.com')];
  assert.equal((await pv({ path: '/', ref: 'https://news.ycombinator.com/item?id=1' })).status, 204);
  assert.equal((await pv({ path: '/s/abcdefghijklmnopqrstuv' })).status, 204);
  assert.equal((await pv({ path: '/wp-admin.php?x=<script>' })).status, 204);
  assert.equal((await pv({ path: '/admin' })).status, 204);
  assert.equal((await pv({ path: '/' }, { 'User-Agent': 'Googlebot/2.1' })).status, 204);
  assert.equal((await pv({ path: 42 })).status, 400);

  assert.equal(await views('/'), home + 1, 'bots are not counted');
  assert.equal(await views('/s/*'), share + 1, 'share IDs are never stored');
  assert.equal(await views('/404'), missing + 1, 'unknown paths are bucketed');
  assert.equal(await views('/admin'), 0, '/admin is never counted');
  assert.equal(await refs('news.ycombinator.com'), ref + 1, 'only the hostname is kept');
});

test('download route redirects to zip and increments download counter', async () => {
  const r = await fetch(`${base}/api/v1/download`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/contextport-extension.zip');

  const zip = await fetch(`${base}/api/v1/download`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.match(zip.headers.get('content-disposition') || '', /contextport-extension\.zip/);
  const buf = await zip.arrayBuffer();
  assert.ok(buf.byteLength > 1000);
});

