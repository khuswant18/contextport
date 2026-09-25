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
