/**
 * Vercel entry point: every /api/* request is rewritten here (see vercel.json)
 * and handled by the same router the standalone server uses. The website is
 * served by Vercel's static hosting, not by this function.
 */

import crypto from 'node:crypto';
import { handle } from '../server/src/app.js';
import { assertConfig } from '../server/src/config.js';
import { migrate, pruneOldUsage, query } from '../server/src/db.js';
import { sendJson } from '../server/src/http.js';

let ready = null;

/** Once per instance: check config, and create tables on the very first deploy. */
function init() {
  ready ??= (async () => {
    assertConfig();
    // The newest table exists only once every migration has run.
    const { rows } = await query(`select to_regclass('public.cp_rate_limits') as t`);
    if (!rows[0].t) await migrate();
  })().catch((err) => {
    ready = null; // retry on the next request
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
    req.url = `/api/${rest}${url.search}`;
  }

  try {
    await init();
  } catch (err) {
    console.error('[init] failed:', err.message);
    return sendJson(res, 503, { error: 'ContextPort AI is starting up. Please try again in a moment.' });
  }

  // Daily cleanup, called by Vercel Cron with "Authorization: Bearer $CRON_SECRET".
  if (req.url.split('?')[0] === '/api/cron/prune') {
    if (!secretMatches(req.headers.authorization, process.env.CRON_SECRET)) return sendJson(res, 401, { error: 'Unauthorized' });
    await pruneOldUsage();
    return sendJson(res, 200, { ok: true });
  }

  return handle(req, res);
}
