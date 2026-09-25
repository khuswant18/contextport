/**
 * Storage for the service worker.
 *
 * - Secrets (API keys, device token) and transfer history live in the
 *   extension's own IndexedDB. Content scripts run in web pages and use the
 *   page's IndexedDB, so they can never read these.
 * - Non-secret preferences live in chrome.storage.local.
 */

const DB_NAME = 'contextport';
const DB_VERSION = 2;
const HISTORY_LIMIT = 200;

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('secrets')) d.createObjectStore('secrets');
        if (!d.objectStoreNames.contains('history')) {
          const s = d.createObjectStore('history', { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt');
        }
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const result = fn(t.objectStore(store));
        t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/* ── secrets ───────────────────────────────────────────────────────── */

export async function getSecret(name) {
  const value = await tx('secrets', 'readonly', (s) => s.get(name));
  return typeof value === 'string' ? value : null;
}
export function setSecret(name, value) {
  return tx('secrets', 'readwrite', (s) => (value ? s.put(value, name) : s.delete(name)));
}

/* ── history ───────────────────────────────────────────────────────── */

export async function saveTransfer(record) {
  await tx('history', 'readwrite', (s) => s.put(record));
  const all = await listTransfers(10_000);
  if (all.length > HISTORY_LIMIT) {
    const extra = all.slice(HISTORY_LIMIT);
    await tx('history', 'readwrite', (s) => extra.forEach((r) => s.delete(r.id)));
  }
}

export async function updateTransfer(id, patch) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('history', 'readwrite');
    const s = t.objectStore('history');
    const g = s.get(id);
    g.onsuccess = () => {
      if (g.result) s.put({ ...g.result, ...patch });
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getTransfer(id) {
  const r = await tx('history', 'readonly', (s) => s.get(id));
  return r || null;
}

export async function listTransfers(limit = 100) {
  const all = (await tx('history', 'readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export function deleteTransfer(id) {
  return tx('history', 'readwrite', (s) => s.delete(id));
}
export function clearTransfers() {
  return tx('history', 'readwrite', (s) => s.clear());
}

/* ── projects ──────────────────────────────────────────────────────── */

export async function listProjects() {
  const all = (await tx('projects', 'readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function putProject(project) {
  return tx('projects', 'readwrite', (s) => s.put(project));
}
export async function getProject(id) {
  return (await tx('projects', 'readonly', (s) => s.get(id))) || null;
}
export function removeProject(id) {
  return tx('projects', 'readwrite', (s) => s.delete(id));
}

/* ── personal (non-secret, user-authored) ──────────────────────────── */

export async function getPersonal() {
  const r = await chrome.storage.local.get(['aboutMe', 'snippets']);
  return { aboutMe: r.aboutMe || '', snippets: Array.isArray(r.snippets) ? r.snippets : DEFAULT_SNIPPETS };
}
export function savePersonal(patch) {
  return chrome.storage.local.set(patch);
}

const DEFAULT_SNIPPETS = [
  { id: 'sn-concise', name: 'Be concise', text: 'Answer concisely. Use short bullet points and skip the preamble.' },
  { id: 'sn-steps', name: 'Step by step', text: 'Walk me through this step by step, and check each step before moving on.' },
  { id: 'sn-review', name: 'Review my code', text: 'Review the following code for bugs, security issues and readability. List issues by severity, then show the fixed code.\n\n' },
];

/* ── lifetime stats (survive history deletion) ─────────────────────── */

export async function getStats() {
  const r = await chrome.storage.local.get('stats');
  return { transfers: 0, delivered: 0, secondsSaved: 0, months: {}, reviewAsked: false, ...(r.stats || {}) };
}
export async function bumpStats(fn) {
  const s = await getStats();
  fn(s);
  await chrome.storage.local.set({ stats: s });
  return s;
}

/* ── settings (non-secret) ─────────────────────────────────────────── */

export const DEFAULT_SETTINGS = {
  engine: 'hosted', // 'hosted' | 'byok' | 'offline'
  provider: 'openai',
  models: {}, // provider -> chosen model id
  defaultDestination: '',
  defaultMode: 'smart',
  showLauncher: true,
  detail: 'standard',
  includeAboutMe: false,
  shareStats: true,
  detectLimits: true,
};

export async function getSettings() {
  const r = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
}

export async function saveSettings(patch) {
  const merged = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: merged });
  return merged;
}
