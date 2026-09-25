/**
 * Durable quotas (Postgres). Atomic "increment if under limit" upserts, so
 * concurrent requests can't race past a limit.
 */

import { query } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';

/** Base daily limit plus any referral bonus the install has earned. */
async function dailyLimit(deviceId) {
  const r = await query(`select bonus_daily from cp_devices where id = $1`, [deviceId]);
  return config.deviceDailyRequests + Number(r.rows[0]?.bonus_daily || 0);
}

/** Reserves one request for the device today, or throws 429. */
export async function reserveDeviceRequest(deviceId) {
  const limit = await dailyLimit(deviceId);
  const r = await query(
    `insert into cp_usage_daily (device_id, day, requests) values ($1, current_date, 1)
     on conflict (device_id, day) do update set requests = cp_usage_daily.requests + 1
     where cp_usage_daily.requests < $2
     returning requests`,
    [deviceId, limit],
  );
  if (r.rowCount === 0) {
    throw new HttpError(429, `You've used today's ${limit} free AI transfers. They reset at midnight UTC. Invite a friend for more, or add your own API key in Settings for unlimited use.`, {
      code: 'daily_limit',
    });
  }
  return r.rows[0].requests;
}

/** Gives a reserved request back (used when the model call fails). */
export async function refundDeviceRequest(deviceId) {
  await query(
    `update cp_usage_daily set requests = greatest(requests - 1, 0) where device_id = $1 and day = current_date`,
    [deviceId],
  );
}

export async function assertGlobalBudget() {
  const r = await query(`select tokens from cp_global_daily where day = current_date`);
  const used = Number(r.rows[0]?.tokens || 0);
  if (used >= config.globalDailyTokens) {
    throw new HttpError(503, 'ContextPort AI has reached its daily capacity. Please try again tomorrow, or add your own API key in Settings.', {
      code: 'global_limit',
    });
  }
}

export async function recordTokens(deviceId, tokens) {
  await query(`update cp_usage_daily set tokens = tokens + $2 where device_id = $1 and day = current_date`, [deviceId, tokens]);
  await query(
    `insert into cp_global_daily (day, requests, tokens) values (current_date, 1, $1)
     on conflict (day) do update set requests = cp_global_daily.requests + 1, tokens = cp_global_daily.tokens + $1`,
    [tokens],
  );
}

export async function getUsage(deviceId) {
  const r = await query(`select requests from cp_usage_daily where device_id = $1 and day = current_date`, [deviceId]);
  return { used: Number(r.rows[0]?.requests || 0), limit: await dailyLimit(deviceId) };
}
