/**
 * Postgres (Neon) access. All queries are parameterised.
 *
 * Privacy: the database never stores conversation content. It holds anonymous
 * device records (hashed tokens) and usage counters for quotas.
 */

import pg from 'pg';
import { config } from './config.js';

let pool;

export function getPool() {
  if (!pool) {
    const url = new URL(config.databaseUrl);
    const wantsChannelBinding = url.searchParams.get('channel_binding') === 'require';
    url.searchParams.delete('channel_binding');
    // Always verify the server certificate and hostname.
    url.searchParams.set('sslmode', 'verify-full');
    pool = new pg.Pool({
      connectionString: url.toString(),
      enableChannelBinding: wantsChannelBinding,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000,
    });
    pool.on('error', (err) => console.error('[db] pool error:', err.code || err.message));
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function closeDb() {
  if (pool) await pool.end();
  pool = undefined;
}

const MIGRATIONS = [
  `create table if not exists cp_devices (
     id uuid primary key,
     token_hash bytea not null unique,
     created_at timestamptz not null default now(),
     last_seen_at timestamptz,
     ip_hash text,
     blocked boolean not null default false
   )`,
  `create table if not exists cp_usage_daily (
     device_id uuid not null references cp_devices(id) on delete cascade,
     day date not null,
     requests integer not null default 0,
     tokens integer not null default 0,
     primary key (device_id, day)
   )`,
  `create table if not exists cp_global_daily (
     day date primary key,
     requests integer not null default 0,
     tokens bigint not null default 0
   )`,
  `create table if not exists cp_ip_daily (
     ip_hash text not null,
     day date not null,
     registrations integer not null default 0,
     primary key (ip_hash, day)
   )`,
  `create index if not exists cp_usage_daily_day on cp_usage_daily(day)`,
  // Referrals: a short public code per install, and extra daily transfers earned.
  `alter table cp_devices add column if not exists referral_code text unique`,
  `alter table cp_devices add column if not exists referred_by uuid`,
  `alter table cp_devices add column if not exists bonus_daily integer not null default 0`,
  `alter table cp_devices add column if not exists referrals_credited integer not null default 0`,
  // Share links hold ONLY ciphertext. The key lives in the URL #fragment, which never reaches the server.
  `create table if not exists cp_shares (
     id text primary key,
     device_id uuid not null references cp_devices(id) on delete cascade,
     ciphertext bytea not null,
     iv bytea not null,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null,
     views integer not null default 0
   )`,
  `create index if not exists cp_shares_expires on cp_shares(expires_at)`,
  `create index if not exists cp_shares_device on cp_shares(device_id, created_at)`,
  // Brief ratings: a thumbs up/down and reason codes. Never any text.
  `create table if not exists cp_feedback (
     id bigserial primary key,
     device_id uuid references cp_devices(id) on delete cascade,
     created_at timestamptz not null default now(),
     rating smallint not null,
     reasons text[] not null default '{}',
     processor text,
     mode text,
     detail text
   )`,
  // Anonymous product events: an allowlisted name + small enum props. Never content.
  `create table if not exists cp_events (
     id bigserial primary key,
     device_id uuid references cp_devices(id) on delete cascade,
     day date not null default current_date,
     created_at timestamptz not null default now(),
     name text not null,
     props jsonb not null default '{}'
   )`,
  `create index if not exists cp_events_day_name on cp_events(day, name)`,
  `create index if not exists cp_events_device on cp_events(device_id, day)`,
  // Tag each install with the server it registered on, so local test runs
  // never count as real users in /admin.
  `alter table cp_devices add column if not exists env text not null default 'legacy'`,
  `create index if not exists cp_devices_env_created on cp_devices(env, created_at)`,
  // Extension downloads from the website: one per network per day.
  `create table if not exists cp_download_seen (
     day date not null default current_date,
     ip_hash text not null,
     env text not null,
     primary key (day, ip_hash, env)
   )`,
  `create table if not exists cp_download_daily (
     day date not null default current_date,
     env text not null,
     downloads integer not null default 0,
     primary key (day, env)
   )`,
  `create table if not exists cp_rate_limits (
     key text not null,
     window_start timestamptz not null,
     hits integer not null default 0,
     primary key (key, window_start)
   )`,
];

export async function migrate() {
  for (const sql of MIGRATIONS) await query(sql);
}

/** Deletes counters older than 60 days so the database stays small. */
export async function pruneOldUsage() {
  await query(`delete from cp_usage_daily where day < current_date - 60`);
  await query(`delete from cp_ip_daily where day < current_date - 7`);
  await query(`delete from cp_global_daily where day < current_date - 365`);
  await query(`delete from cp_shares where expires_at < now()`);
  await query(`delete from cp_events where day < current_date - 180`);
  await query(`delete from cp_feedback where created_at < now() - interval '365 days'`);
  await query(`delete from cp_rate_limits where window_start < now() - interval '1 day'`);
  await query(`delete from cp_download_seen where day < current_date - 2`);
}
