/**
 * Engagement features: encrypted share links, referrals, brief ratings,
 * anonymous usage events and admin metrics.
 *
 * Privacy rules enforced here:
 * - Share links store ciphertext only; the decryption key never reaches us.
 * - Events and ratings accept allowlisted names/enums only, never free text.
 */

import crypto from 'node:crypto';
import { query, getPool } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';
import { EVENT_NAMES, PLATFORM_IDS, DETAIL_LEVELS } from '../../shared/constants.js';

/* ── share links ───────────────────────────────────────────────────── */

const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_SHARE_BYTES = 400_000;

function fromB64url(s, name, max) {
  if (typeof s !== 'string' || !B64URL_RE.test(s) || s.length > Math.ceil((max * 4) / 3) + 4) throw new HttpError(400, `Invalid ${name}`);
  return Buffer.from(s, 'base64url');
}

export async function createShare(deviceId, body) {
  const ciphertext = fromB64url(body.ciphertext, 'ciphertext', MAX_SHARE_BYTES);
  const iv = fromB64url(body.iv, 'iv', 12);
  if (iv.length !== 12 || ciphertext.length < 17) throw new HttpError(400, 'Invalid encrypted payload');
  const days = Math.min(30, Math.max(1, Number.parseInt(body.ttlDays, 10) || 7));

  const count = await query(`select count(*)::int as n from cp_shares where device_id = $1 and created_at > now() - interval '1 day'`, [deviceId]);
  if (count.rows[0].n >= config.sharesPerDevicePerDay) throw new HttpError(429, 'Daily share-link limit reached. Try again tomorrow.');

  const id = crypto.randomBytes(16).toString('base64url');
  const r = await query(
    `insert into cp_shares (id, device_id, ciphertext, iv, expires_at) values ($1, $2, $3, $4, now() + ($5 || ' days')::interval) returning expires_at`,
    [id, deviceId, ciphertext, iv, String(days)],
  );
  return { id, expiresAt: r.rows[0].expires_at };
}

export async function readShare(id) {
  if (!SHARE_ID_RE.test(id)) throw new HttpError(404, 'This link is invalid or has expired.');
  const r = await query(
    `update cp_shares set views = views + 1 where id = $1 and expires_at > now() returning ciphertext, iv, expires_at`,
    [id],
  );
  if (r.rowCount === 0) throw new HttpError(404, 'This link is invalid or has expired.');
  const row = r.rows[0];
  return { ciphertext: row.ciphertext.toString('base64url'), iv: row.iv.toString('base64url'), expiresAt: row.expires_at };
}

export async function deleteShare(deviceId, id) {
  if (!SHARE_ID_RE.test(id)) throw new HttpError(404, 'Not found');
  const r = await query(`delete from cp_shares where id = $1 and device_id = $2`, [id, deviceId]);
  if (r.rowCount === 0) throw new HttpError(404, 'Not found');
}

/* ── referrals ─────────────────────────────────────────────────────── */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/;

function newCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export async function getReferral(deviceId) {
  let r = await query(`select referral_code, referrals_credited, bonus_daily, referred_by from cp_devices where id = $1`, [deviceId]);
  let row = r.rows[0];
  if (!row.referral_code) {
    for (let i = 0; i < 5 && !row.referral_code; i++) {
      try {
        r = await query(`update cp_devices set referral_code = $2 where id = $1 and referral_code is null returning referral_code, referrals_credited, bonus_daily, referred_by`, [deviceId, newCode()]);
        if (r.rowCount) row = r.rows[0];
        else row = (await query(`select referral_code, referrals_credited, bonus_daily, referred_by from cp_devices where id = $1`, [deviceId])).rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err; // unique collision -> retry
      }
    }
  }
  return {
    code: row.referral_code,
    credited: row.referrals_credited,
    bonusDaily: row.bonus_daily,
    redeemed: !!row.referred_by,
    bonusPerReferral: config.referralBonus,
    maxReferrals: config.maxReferralsCredited,
  };
}

/**
 * Anti-abuse: only fresh installs (≤ 7 days) can redeem, once; not your own
 * code; not from the same network as the referrer; referrer bonus is capped.
 */
export async function redeemReferral(deviceId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new HttpError(400, 'That invite code doesn’t look right.');
  const normalized = code.includes('-') ? code : `${code.slice(0, 4)}-${code.slice(4)}`;

  const client = await getPool().connect();
  try {
    await client.query('begin');
    const me = (await client.query(`select id, referred_by, created_at, ip_hash from cp_devices where id = $1 for update`, [deviceId])).rows[0];
    if (me.referred_by) throw new HttpError(409, 'You’ve already used an invite code.');
    if (Date.now() - new Date(me.created_at).getTime() > 7 * 86_400_000) throw new HttpError(400, 'Invite codes can only be used in the first 7 days after installing.');
    const ref = (await client.query(`select id, ip_hash, referrals_credited from cp_devices where referral_code = $1 for update`, [normalized])).rows[0];
    if (!ref) throw new HttpError(404, 'No invite found with that code.');
    if (ref.id === deviceId) throw new HttpError(400, 'You can’t use your own invite code.');
    if (ref.ip_hash && ref.ip_hash === me.ip_hash) throw new HttpError(400, 'Invite codes need to come from someone on a different network.');

    await client.query(`update cp_devices set referred_by = $2, bonus_daily = bonus_daily + $3 where id = $1`, [deviceId, ref.id, config.referralBonus]);
    if (ref.referrals_credited < config.maxReferralsCredited) {
      await client.query(`update cp_devices set referrals_credited = referrals_credited + 1, bonus_daily = bonus_daily + $2 where id = $1`, [ref.id, config.referralBonus]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getReferral(deviceId);
}

/* ── ratings ───────────────────────────────────────────────────────── */

export const FEEDBACK_REASONS = ['missed_requirements', 'missing_code', 'wrong_latest', 'too_long', 'too_short', 'inaccurate', 'other'];
const PROCESSORS = ['hosted', 'byok', 'offline', 'none'];

export async function recordFeedback(deviceId, body) {
  const rating = body.rating === 1 ? 1 : body.rating === -1 ? -1 : null;
  if (!rating) throw new HttpError(400, 'Invalid rating');
  const reasons = Array.isArray(body.reasons) ? [...new Set(body.reasons.filter((r) => FEEDBACK_REASONS.includes(r)))].slice(0, 7) : [];
  await query(`insert into cp_feedback (device_id, rating, reasons, processor, mode, detail) values ($1, $2, $3, $4, $5, $6)`, [
    deviceId,
    rating,
    reasons,
    PROCESSORS.includes(body.processor) ? body.processor : null,
    ['smart', 'full'].includes(body.mode) ? body.mode : null,
    DETAIL_LEVELS.includes(body.detail) ? body.detail : null,
  ]);
}

/* ── anonymous events ─────────────────────────────────────────────── */

const PROP_VALUES = {
  source: PLATFORM_IDS,
  destination: PLATFORM_IDS,
  processor: PROCESSORS,
  mode: ['smart', 'full'],
  detail: DETAIL_LEVELS,
  scope: ['all', 'recent', 'last'],
  trigger: ['launcher', 'popup', 'shortcut', 'message', 'limit', 'long_chat', 'library', 'onboarding', 'menu', 'empty_chat'],
  provider: ['openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'deepseek', 'mistral', 'xai', 'together'],
  rating: ['up', 'down'],
  version: null, // validated by pattern below
};

function cleanProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  for (const [k, v] of Object.entries(props)) {
    if (!(k in PROP_VALUES) || typeof v !== 'string') continue;
    if (k === 'version') {
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) out[k] = v;
    } else if (PROP_VALUES[k].includes(v)) out[k] = v;
  }
  return out;
}

export async function recordEvents(deviceId, body) {
  const events = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
  const rows = events.filter((e) => e && EVENT_NAMES.includes(e.name)).map((e) => [e.name, JSON.stringify(cleanProps(e.props))]);
  if (!rows.length) return 0;
  const values = rows.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3}::jsonb)`).join(',');
  await query(`insert into cp_events (device_id, name, props) values ${values}`, [deviceId, ...rows.flat()]);
  return rows.length;
}

/* ── admin metrics ─────────────────────────────────────────────────── */

export function checkAdmin(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = config.adminToken;
  if (!expected || expected.length < 32) throw new HttpError(404, 'Not found');
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
}

/* ── downloads ────────────────────────────────────────────────────── */

const STATS_ENV = () => (config.isProd ? 'production' : 'development');

/** Counts a zip download once per network per day (IP stored only as a keyed hash). */
export async function recordDownload(ipHash) {
  const env = STATS_ENV();
  const r = await query(`insert into cp_download_seen (ip_hash, env) values ($1, $2) on conflict do nothing`, [ipHash, env]);
  if (r.rowCount) {
    await query(
      `insert into cp_download_daily (env, downloads) values ($1, 1)
       on conflict (day, env) do update set downloads = cp_download_daily.downloads + 1`,
      [env],
    );
  }
}

/* ── admin metrics (only installs registered on this server's environment) ── */

export async function adminStats() {
  const env = STATS_ENV();
  const [installs, downloads, totals, activation, retention, weekly, features, feedback, reasons, tokens] = await Promise.all([
    query(`select created_at::date::text as day, count(*)::int as installs from cp_devices where env = $1 and created_at > now() - interval '30 days' group by 1 order by 1`, [env]),
    query(`select day::text, downloads from cp_download_daily where env = $1 and day > current_date - 30 order by day`, [env]),
    query(
      `select (select count(*)::int from cp_devices where env = $1) as installs_total,
              (select count(*)::int from cp_devices where env = $1 and created_at::date = current_date) as installs_today,
              (select coalesce(sum(downloads), 0)::int from cp_download_daily where env = $1) as downloads_total,
              (select coalesce(sum(downloads), 0)::int from cp_download_daily where env = $1 and day = current_date) as downloads_today`,
      [env],
    ),
    // Activation: installs (1–30 days old) that made a transfer within 24h of installing.
    query(
      `select count(*)::int as installs,
              count(*) filter (where exists (
                select 1 from cp_events e where e.device_id = d.id and e.name = 'handoff' and e.created_at < d.created_at + interval '24 hours'
              ))::int as activated
         from cp_devices d where d.env = $1 and d.created_at between now() - interval '30 days' and now() - interval '1 day'`,
      [env],
    ),
    query(
      `select
         count(*) filter (where d.created_at < now() - interval '7 days')::int as eligible7,
         count(*) filter (where d.created_at < now() - interval '7 days' and exists (select 1 from cp_events e where e.device_id = d.id and e.created_at >= d.created_at + interval '7 days'))::int as retained7,
         count(*) filter (where d.created_at < now() - interval '30 days')::int as eligible30,
         count(*) filter (where d.created_at < now() - interval '30 days' and exists (select 1 from cp_events e where e.device_id = d.id and e.created_at >= d.created_at + interval '30 days'))::int as retained30
       from cp_devices d where d.env = $1 and d.created_at > now() - interval '120 days'`,
      [env],
    ),
    query(
      `select count(*)::int as transfers, count(distinct e.device_id)::int as active_devices
         from cp_events e join cp_devices d on d.id = e.device_id
        where d.env = $1 and e.name = 'handoff' and e.day > current_date - 7`,
      [env],
    ),
    query(
      `select e.name, count(*)::int as n from cp_events e join cp_devices d on d.id = e.device_id
        where d.env = $1 and e.day > current_date - 7 group by e.name order by n desc`,
      [env],
    ),
    query(
      `select count(*) filter (where f.rating = 1)::int as up, count(*) filter (where f.rating = -1)::int as down
         from cp_feedback f join cp_devices d on d.id = f.device_id where d.env = $1 and f.created_at > now() - interval '30 days'`,
      [env],
    ),
    query(
      `select unnest(f.reasons) as reason, count(*)::int as n from cp_feedback f join cp_devices d on d.id = f.device_id
        where d.env = $1 and f.created_at > now() - interval '30 days' group by reason order by n desc`,
      [env],
    ),
    query(`select requests, tokens::text from cp_global_daily where day = current_date`),
  ]);
  const a = activation.rows[0];
  const r = retention.rows[0];
  const w = weekly.rows[0];
  const t = totals.rows[0];
  const f = feedback.rows[0];
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  // One row per day with both numbers.
  const byDay = new Map();
  for (const row of downloads.rows) byDay.set(row.day, { day: row.day, downloads: row.downloads, installs: 0 });
  for (const row of installs.rows) byDay.set(row.day, { ...(byDay.get(row.day) || { day: row.day, downloads: 0 }), installs: row.installs });
  return {
    environment: env,
    totals: {
      installs: t.installs_total,
      installsToday: t.installs_today,
      downloads: t.downloads_total,
      downloadsToday: t.downloads_today,
      downloadToInstall: pct(t.installs_total, t.downloads_total),
    },
    installsByDay: [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day)),
    activationRate: pct(a.activated, a.installs),
    retentionD7: pct(r.retained7, r.eligible7),
    retentionD30: pct(r.retained30, r.eligible30),
    transfersLast7d: w.transfers,
    activeDevicesLast7d: w.active_devices,
    transfersPerActivePerWeek: w.active_devices ? Math.round((w.transfers / w.active_devices) * 10) / 10 : 0,
    featureUseLast7d: features.rows,
    feedback30d: { up: f.up, down: f.down, satisfaction: pct(f.up, f.up + f.down), reasons: reasons.rows },
    hostedToday: tokens.rows[0] || { requests: 0, tokens: '0' },
  };
}
