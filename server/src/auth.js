/**
 * Anonymous device auth. Each extension install registers once and receives a
 * random bearer token. Only the SHA-256 of the token is stored, so a database
 * leak does not expose usable tokens.
 */

import crypto from 'node:crypto';
import { query } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';

const TOKEN_RE = /^cp_[A-Za-z0-9_-]{43}$/;

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest();
}

export function hashIp(ip) {
  return crypto.createHmac('sha256', config.ipHashSecret).update(ip || 'unknown').digest('base64url').slice(0, 32);
}

export async function registerDevice(ip) {
  const ipHash = hashIp(ip);
  const r = await query(
    `insert into cp_ip_daily (ip_hash, day, registrations) values ($1, current_date, 1)
     on conflict (ip_hash, day) do update set registrations = cp_ip_daily.registrations + 1
     where cp_ip_daily.registrations < $2
     returning registrations`,
    [ipHash, config.registrationsPerIpPerDay],
  );
  if (r.rowCount === 0) throw new HttpError(429, 'Too many new installs from this network today. Try again tomorrow.');

  const token = `cp_${crypto.randomBytes(32).toString('base64url')}`;
  const id = crypto.randomUUID();
  await query(`insert into cp_devices (id, token_hash, ip_hash, env) values ($1, $2, $3, $4)`, [id, hashToken(token), ipHash, config.isProd ? 'production' : 'development']);
  return { token };
}

/** Resolves the Authorization header to a device, or throws 401/403. */
export async function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!TOKEN_RE.test(token)) throw new HttpError(401, 'Missing or invalid device token');
  const r = await query(
    `update cp_devices set last_seen_at = now() where token_hash = $1 returning id, blocked`,
    [hashToken(token)],
  );
  if (r.rowCount === 0) throw new HttpError(401, 'Unknown device token');
  if (r.rows[0].blocked) throw new HttpError(403, 'This install has been blocked');
  return { deviceId: r.rows[0].id };
}
