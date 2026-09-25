/** Helpers shared by the popup, side panel and settings pages. */

export function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || 'Something went wrong'));
      resolve(res.data);
    });
  });
}

export function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

export const STATUS_LABEL = {
  opening: 'Opening',
  inserting: 'Inserting',
  delivered: 'Delivered',
  inserted: 'Delivered',
  failed: 'Needs paste',
  canceled: 'Canceled',
  sent: 'Sent',
  saved: 'Saved',
};

/** "ChatGPT → Claude", or "Fresh ChatGPT chat" when a chat was restarted on the same AI. */
export function routeLabel(source, destination, name) {
  if (!destination) return `From ${name(source)}`;
  return source === destination ? `Fresh ${name(source)} chat` : `${name(source)} → ${name(destination)}`;
}

export async function activeTabStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { tab: null, status: null };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_STATUS' });
    return { tab, status: res?.ok ? res.data : null };
  } catch {
    return { tab, status: null };
  }
}

export async function openTransferInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL' });
    return true;
  } catch {
    return false;
  }
}
