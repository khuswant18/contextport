import crypto from 'node:crypto';
import { handle } from '../server/src/app.js';
import { assertConfig } from '../server/src/config.js';
import { migrate, pruneOldUsage, query } from '../server/src/db.js';
import { sendJson } from '../server/src/http.js';

let ready = null;

function init() {
  ready ??= (async () => {
    assertConfig();
    // Check for the newest table; migrations are idempotent.
    const { rows } = await query(`select to_regclass('public.cp_referrer_daily') as t`);
    if (!rows[0].t) await migrate();
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

function secretMatches(given, expected) {
  if (!expected || expected.length < 16 || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(`Bearer ${expected}`).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  // Rewrites deliver /api/handler?__p=<rest>; restore the original path.
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/handler') {
    const rest = url.searchParams.get('__p') || '';
    url.searchParams.delete('__p');
    req.url = `/api/${rest}${url.search ? url.search : ''}`;
  }

  // Fast path for download: counting is best-effort and must never block handing over the zip.
  const isDownload = req.url.startsWith('/api/v1/download');

  try {
    await init();
  } catch (err) {
    console.error('[init] failed:', err.message);
    if (!isDownload) {
      return sendJson(res, 503, { error: 'ContextPort AI is starting up. Please try again in a moment.' });
    }
  }

  if (req.url.split('?')[0] === '/api/cron/prune') {
    if (!secretMatches(req.headers.authorization, process.env.CRON_SECRET)) return sendJson(res, 401, { error: 'Unauthorized' });
    await pruneOldUsage();
    return sendJson(res, 200, { ok: true });
  }

  return handle(req, res);
}
