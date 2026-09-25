/**
 * Fixed-window rate limiter stored in Postgres, so limits hold across
 * serverless instances (Vercel) and multiple containers. One atomic upsert
 * per check. Use the in-memory RateLimiter (http.js) only for cheap,
 * best-effort limits.
 */

import crypto from 'node:crypto';
import { query } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';

export class DbRateLimiter {
  /** @param {{name: string, windowMs: number, max: number}} opts */
  constructor({ name, windowMs, max }) {
    this.name = name;
    this.windowMs = windowMs;
    this.max = max;
  }

  async check(key) {
    const now = Date.now();
    const windowStart = new Date(Math.floor(now / this.windowMs) * this.windowMs);
    const { rows } = await query(
      `insert into cp_rate_limits (key, window_start, hits) values ($1, $2, 1)
       on conflict (key, window_start) do update set hits = cp_rate_limits.hits + 1
       returning hits`,
      // Keys can contain IPs; store only a keyed hash.
      [`${this.name}:${crypto.createHmac('sha256', config.ipHashSecret).update(String(key)).digest('base64url').slice(0, 32)}`, windowStart],
    );
    if (rows[0].hits > this.max) {
      const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + this.windowMs - now) / 1000));
      throw new HttpError(429, 'Too many requests. Please slow down.', { retryAfter });
    }
  }
}
