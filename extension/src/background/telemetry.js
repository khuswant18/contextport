/**
 * Anonymous usage events (opt-out in Settings). Only allowlisted event names
 * and small enum properties are sent — never conversation text, titles or URLs.
 */

import { API_BASE } from '../config.js';
import { EVENT_NAMES } from '../../../shared/constants.js';
import { getSettings } from './store.js';
import { deviceToken } from './engine.js';

const MAX_QUEUE = 200;
const FLUSH_EVERY_MS = 2 * 60_000;
let flushing = false;

export async function track(name, props = {}) {
  if (!EVENT_NAMES.includes(name)) return;
  const settings = await getSettings();
  if (!settings.shareStats) return;
  const { eventQueue = [] } = await chrome.storage.local.get('eventQueue');
  eventQueue.push({ name, props: { ...props, version: chrome.runtime.getManifest().version } });
  await chrome.storage.local.set({ eventQueue: eventQueue.slice(-MAX_QUEUE) });
  const { lastFlush = 0 } = await chrome.storage.local.get('lastFlush');
  if (eventQueue.length >= 10 || Date.now() - lastFlush > FLUSH_EVERY_MS) flush();
}

export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const { eventQueue = [] } = await chrome.storage.local.get('eventQueue');
    if (!eventQueue.length) return;
    const batch = eventQueue.slice(0, 50);
    const token = await deviceToken();
    const res = await fetch(`${API_BASE}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok || res.status === 400) {
      const { eventQueue: current = [] } = await chrome.storage.local.get('eventQueue');
      await chrome.storage.local.set({ eventQueue: current.slice(batch.length), lastFlush: Date.now() });
    }
  } catch {
    /* offline: keep the queue for later */
  } finally {
    flushing = false;
  }
}

export async function clearQueue() {
  await chrome.storage.local.set({ eventQueue: [] });
}
