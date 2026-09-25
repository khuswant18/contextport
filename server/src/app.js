/**
 * Request router: JSON API under /api, and the static website for everything else.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError, readJson, sendJson, baseSecurityHeaders, clientIp, RateLimiter, SITE_CSP } from './http.js';
import { registerDevice, authenticate } from './auth.js';
import { reserveDeviceRequest, refundDeviceRequest, assertGlobalBudget, recordTokens, getUsage } from './quota.js';
import { hostedComplete } from './groq.js';
import { createBrief } from '../../shared/pipeline.js';
import { PLATFORM_IDS, LIMITS, DETAIL_LEVELS } from '../../shared/constants.js';
import { DbRateLimiter } from './ratelimit.js';
import { createShare, readShare, deleteShare, getReferral, redeemReferral, recordFeedback, recordEvents, checkAdmin, adminStats } from './growth.js';

// Cheap per-instance flood guard; the limits that protect money and abuse
// live in Postgres so they also hold on serverless hosts.
const ipLimiter = new RateLimiter({ windowMs: 60_000, max: 60 });
const registerLimiter = new DbRateLimiter({ name: 'reg', windowMs: 60 * 60_000, max: config.registrationsPerIpPerHour });
const briefLimiter = new DbRateLimiter({ name: 'brief', windowMs: 60_000, max: 6 });
const writeLimiter = new DbRateLimiter({ name: 'write', windowMs: 60_000, max: 30 }); // shares, feedback, events, referrals
const redeemLimiter = new DbRateLimiter({ name: 'redeem', windowMs: 60 * 60_000, max: 10 });
const SHARE_PATH = /^\/api\/v1\/shares\/([A-Za-z0-9_-]{1,64})$/;

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // non-browser clients still need a valid device token
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (!m) throw new HttpError(403, 'Forbidden');
  if (config.allowedExtensionIds.length && !config.allowedExtensionIds.includes(m[1])) throw new HttpError(403, 'Forbidden');
}

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  ipLimiter.check(`ip:${ip}`);

  if (req.method === 'OPTIONS') throw new HttpError(403, 'Forbidden'); // no CORS: websites can't call this API
  if (url.pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true });
  }

  // Public, read-only routes used by the website (same origin).
  const shareMatch = SHARE_PATH.exec(url.pathname);
  if (shareMatch && req.method === 'GET') {
    return sendJson(res, 200, await readShare(shareMatch[1]));
  }
  if (url.pathname === '/api/v1/admin/stats' && req.method === 'GET') {
    checkAdmin(req);
    return sendJson(res, 200, await adminStats());
  }

  checkOrigin(req);

  if (url.pathname === '/api/v1/shares' && req.method === 'POST') {
    const { deviceId } = await authenticate(req);
    await writeLimiter.check(`w:${deviceId}`);
    return sendJson(res, 201, await createShare(deviceId, await readJson(req, 600_000)));
  }
  if (shareMatch && req.method === 'DELETE') {
    const { deviceId } = await authenticate(req);
    await deleteShare(deviceId, shareMatch[1]);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/v1/referral' && req.method === 'GET') {
    const { deviceId } = await authenticate(req);
    return sendJson(res, 200, await getReferral(deviceId));
  }
  if (url.pathname === '/api/v1/referral/redeem' && req.method === 'POST') {
    const { deviceId } = await authenticate(req);
    await redeemLimiter.check(`r:${deviceId}`);
    const body = await readJson(req, 2_000);
    return sendJson(res, 200, await redeemReferral(deviceId, body.code));
  }
  if (url.pathname === '/api/v1/feedback' && req.method === 'POST') {
    const { deviceId } = await authenticate(req);
    await writeLimiter.check(`w:${deviceId}`);
    await recordFeedback(deviceId, await readJson(req, 4_000));
    return sendJson(res, 201, { ok: true });
  }
  if (url.pathname === '/api/v1/events' && req.method === 'POST') {
    const { deviceId } = await authenticate(req);
    await writeLimiter.check(`w:${deviceId}`);
    const n = await recordEvents(deviceId, await readJson(req, 20_000));
    return sendJson(res, 202, { accepted: n });
  }

  if (url.pathname === '/api/v1/devices' && req.method === 'POST') {
    await registerLimiter.check(`reg:${ip}`);
    await readJson(req, 2_000);
    const { token } = await registerDevice(ip);
    return sendJson(res, 201, { token });
  }

  if (url.pathname === '/api/v1/usage' && req.method === 'GET') {
    const { deviceId } = await authenticate(req);
    return sendJson(res, 200, await getUsage(deviceId));
  }

  if (url.pathname === '/api/v1/brief' && req.method === 'POST') {
    const { deviceId } = await authenticate(req);
    await briefLimiter.check(`dev:${deviceId}`);
    const body = await readJson(req);

    const sourcePlatform = PLATFORM_IDS.includes(body.sourcePlatform) ? body.sourcePlatform : null;
    if (!sourcePlatform) throw new HttpError(400, 'Unsupported source platform');
    const title = typeof body.title === 'string' ? body.title.slice(0, LIMITS.maxTitleChars) : '';

    await assertGlobalBudget();
    await reserveDeviceRequest(deviceId);
    let tokens = 0;
    try {
      const result = await createBrief({
        messages: body.messages,
        sourcePlatform,
        title,
        budgetTokens: config.hostedTranscriptTokens,
        detail: DETAIL_LEVELS.includes(body.detail) ? body.detail : 'standard',
        callModel: async (prompt) => {
          const r = await hostedComplete(prompt);
          tokens = r.tokens;
          return r.text;
        },
      });
      await recordTokens(deviceId, tokens);
      const usage = await getUsage(deviceId);
      return sendJson(res, 200, { ...result, processor: 'contextport', usage });
    } catch (err) {
      await refundDeviceRequest(deviceId).catch(() => {});
      if (err instanceof HttpError || err.name === 'InputError') throw err;
      console.warn('[brief] failed:', err.message);
      throw new HttpError(502, 'ContextPort AI could not summarise this conversation. Please try again.');
    }
  }

  throw new HttpError(404, 'Not found');
}

/* ── static site ───────────────────────────────────────────────────── */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  const root = path.resolve(config.siteDir);
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (rel.includes('\0')) throw new HttpError(400, 'Bad path');
  let file = path.resolve(root, `.${path.posix.normalize(rel)}`);
  if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(404, 'Not found');

  let stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!stat || !stat.isFile()) {
    // SPA fallback for client-side routes (paths without a file extension).
    if (path.extname(rel)) throw new HttpError(404, 'Not found');
    file = path.join(root, 'index.html');
    stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) throw new HttpError(404, 'Website not built. Run: npm run build:site');
  }

  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (ext === '.html') headers['Content-Security-Policy'] = SITE_CSP;
  if (/^\/(s|admin)(\/|$)/.test(rel)) {
    // Private pages: never index, never leak the URL via Referer.
    headers['X-Robots-Tag'] = 'noindex, nofollow';
    headers['Referrer-Policy'] = 'no-referrer';
    headers['Cache-Control'] = 'no-store';
  }
  if (ext === '.zip') headers['Content-Disposition'] = 'attachment; filename="contextport-extension.zip"';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

export async function handle(req, res) {
  const started = Date.now();
  const reqId = crypto.randomBytes(6).toString('hex');
  baseSecurityHeaders(res);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500 && !(err instanceof HttpError)) console.error(`[${reqId}] unhandled:`, err.stack || err.message);
    if (!res.headersSent) {
      if (err.extra?.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
      const message = err instanceof HttpError || err.name === 'InputError' ? err.message : 'Internal error';
      sendJson(res, status, { error: message, code: err.extra?.code, requestId: reqId });
    } else {
      res.destroy();
    }
  } finally {
    if (url?.pathname.startsWith('/api/')) {
      res.on('finish', () => console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    }
  }
}
