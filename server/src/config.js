/**
 * Server configuration from environment. Secrets are read here and nowhere else.
 */

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid integer for ${name}`);
  return n;
}

function list(name, def) {
  const v = process.env[name];
  return (v ? v.split(',') : def).map((s) => s.trim()).filter(Boolean);
}

const env = process.env.NODE_ENV || 'development';

export const config = {
  env,
  isProd: env === 'production',
  port: int('PORT', 8787),
  host: process.env.HOST || (env === 'production' ? '0.0.0.0' : '127.0.0.1'),
  /** Only trust X-Forwarded-For when running behind a known proxy (Render, Fly, Railway, nginx…). */
  trustProxy: process.env.TRUST_PROXY === '1',

  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModels: list('GROQ_MODELS', ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']),
  /** Transcript budget per hosted request. Raise when your Groq tier allows more tokens/minute. */
  hostedTranscriptTokens: int('HOSTED_TRANSCRIPT_TOKENS', 4200),
  hostedMaxOutputTokens: int('HOSTED_MAX_OUTPUT_TOKENS', 2200),
  maxConcurrentModelCalls: int('MAX_CONCURRENT_MODEL_CALLS', 4),
  maxQueuedModelCalls: int('MAX_QUEUED_MODEL_CALLS', 40),

  databaseUrl: process.env.DATABASE_URL || '',
  ipHashSecret: process.env.IP_HASH_SECRET || '',

  deviceDailyRequests: int('DEVICE_DAILY_REQUESTS', 30),
  globalDailyTokens: int('GLOBAL_DAILY_TOKENS', 5_000_000),
  registrationsPerIpPerDay: int('REGISTRATIONS_PER_IP_PER_DAY', 10),
  registrationsPerIpPerHour: int('REGISTRATIONS_PER_IP_PER_HOUR', 5),

  referralBonus: int('REFERRAL_BONUS_DAILY', 5),
  maxReferralsCredited: int('MAX_REFERRALS_CREDITED', 10),
  sharesPerDevicePerDay: int('SHARES_PER_DEVICE_PER_DAY', 30),
  /** Bearer token for GET /api/v1/admin/stats (32+ chars). Unset = admin API disabled. */
  adminToken: process.env.ADMIN_TOKEN || '',
  /** Sign-in for the /admin page. Override both in the host's secret settings. */
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '12345678',
  /** How long an /admin sign-in lasts. */
  adminSessionHours: int('ADMIN_SESSION_HOURS', 12),

  /** Optional: lock the API to your published extension ID(s). */
  allowedExtensionIds: list('ALLOWED_EXTENSION_IDS', []),
  siteDir: process.env.SITE_DIR || new URL('../../site/dist/', import.meta.url).pathname,
};

export function assertConfig() {
  const missing = [];
  if (!config.groqApiKey) missing.push('GROQ_API_KEY');
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.ipHashSecret || config.ipHashSecret.length < 32) missing.push('IP_HASH_SECRET (32+ chars)');
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`);
}
