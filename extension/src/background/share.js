/**
 * End-to-end encrypted share links.
 *
 * The packet is encrypted here with a fresh AES-256-GCM key. The server gets
 * only ciphertext; the key goes in the URL #fragment, which browsers never
 * send to servers. Anyone with the full link can read it; nobody else can,
 * including ContextPort.
 */

import { API_BASE } from '../config.js';
import { deviceToken } from './engine.js';

const MAX_PLAINTEXT = 280_000;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function b64urlLarge(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Only what the reader needs — never the source URL. */
function shareablePacket(packet) {
  const p = {
    v: 1,
    mode: packet.mode,
    source: { platform: packet.source.platform, title: packet.source.title || '' },
    brief: packet.brief,
    code: packet.code || [],
    createdAt: packet.createdAt,
  };
  if (packet.mode === 'full') p.messages = packet.messages || [];
  let json = JSON.stringify(p);
  while (json.length > MAX_PLAINTEXT && p.messages?.length > 2) {
    p.messages = [p.messages[0], ...p.messages.slice(Math.ceil(p.messages.length / 2))];
    json = JSON.stringify(p);
  }
  if (json.length > MAX_PLAINTEXT) throw new Error('This conversation is too large to share as a link. Use Copy or Export instead.');
  return json;
}

export async function createShareLink(packet, ttlDays = 7) {
  const plaintext = new TextEncoder().encode(shareablePacket(packet));
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const rawKey = await crypto.subtle.exportKey('raw', key);

  const token = await deviceToken();
  const res = await fetch(`${API_BASE}/api/v1/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ciphertext: b64urlLarge(ciphertext), iv: b64url(iv), ttlDays }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Could not create a share link.');
  return { url: `${API_BASE}/s/${j.id}#${b64url(rawKey)}`, id: j.id, expiresAt: j.expiresAt };
}

export async function revokeShareLink(id) {
  const token = await deviceToken();
  const res = await fetch(`${API_BASE}/api/v1/shares/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) throw new Error('Could not revoke the link.');
}

async function authed(path, init = {}) {
  const token = await deviceToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}

export const getReferral = () => authed('/api/v1/referral');
export const redeemReferral = (code) => authed('/api/v1/referral/redeem', { method: 'POST', body: JSON.stringify({ code }) });
export const sendFeedback = (body) => authed('/api/v1/feedback', { method: 'POST', body: JSON.stringify(body) });
