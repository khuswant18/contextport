/**
 * Content script entry. Runs on supported AI sites.
 *  - Source side: launcher, menu and nudges open the Transfer sheet.
 *  - Destination side: claims a pending hand-off for this tab and inserts it.
 */

import { currentAdapter, readConversation, quickStats } from './adapters.js';
import { openPanel, onPanelChange } from './panel.js';
import { toast, hideToast, askAboutDraft } from './shell.js';
import { waitForComposer, insertText, composerText } from './inject.js';
import { setupLauncher, setupNudges, setupSnippetTrigger, openSnippetPicker } from './engage.js';

const adapter = currentAdapter();

if (adapter && !window.__contextportLoaded) {
  window.__contextportLoaded = true;
  init();
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        void chrome.runtime.lastError;
        resolve(res?.ok ? res.data : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function init() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.type === 'OPEN_PANEL') {
      openPanel(adapter, { trigger: msg.trigger || 'popup', fresh: !!msg.fresh, insert: !!msg.insert });
      sendResponse({ ok: true });
    } else if (msg?.type === 'PENDING_READY') {
      claimHandoff();
      sendResponse({ ok: true });
    } else if (msg?.type === 'OPEN_SNIPPETS') {
      openSnippetPicker(adapter);
      sendResponse({ ok: true });
    } else if (msg?.type === 'PAGE_STATUS') {
      let count = 0;
      try {
        count = readConversation(adapter, 'all').length;
      } catch {
        /* ignore */
      }
      sendResponse({ ok: true, data: { platform: adapter.id, name: adapter.name, messages: count, generating: adapter.isGenerating() } });
    }
    return false;
  });

  claimHandoff();

  const ui = (await send({ type: 'UI_SETTINGS' })) || {};
  const launcher = setupLauncher(adapter, ui);
  setupSnippetTrigger(adapter);
  const checkNudges = setupNudges(adapter, ui);

  // One debounced observer drives the launcher and nudges. The launcher update
  // is trivial; nudge checks read the page, so they run at most every few
  // seconds, only when idle, and never while the tab is hidden, the reply is
  // still streaming or the user is typing.
  const NUDGE_INTERVAL_MS = 5000;
  let timer;
  let lastNudge = 0;
  let lastTyped = 0;
  document.addEventListener('input', () => (lastTyped = Date.now()), { capture: true, passive: true });
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 200));
  function nudgeCheck() {
    if (document.hidden || Date.now() - lastTyped < 3000 || Date.now() - lastNudge < NUDGE_INTERVAL_MS) return;
    try {
      if (!adapter.hasReply() || adapter.isGenerating()) return;
    } catch {
      return;
    }
    lastNudge = Date.now();
    idle(() => checkNudges(quickStats(adapter)));
  }
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      let hasReply = false;
      try {
        hasReply = adapter.hasReply();
      } catch {
        /* ignore */
      }
      launcher.refresh(hasReply);
      nudgeCheck();
    }, 800);
  };
  onPanelChange(() => launcher.refresh(false));
  new MutationObserver(refresh).observe(document.body || document.documentElement, { childList: true, subtree: true });
  refresh();

  // Sites often move from their sign-in page to the chat without a reload.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    const wasSignIn = /\/(login|signin|sign-in|auth)\b/i.test(lastPath);
    lastPath = location.pathname;
    if (wasSignIn) claimHandoff();
  }, 1000);
}

/* ── destination: insert pending context ───────────────────────────── */

let claiming = false;

async function claimHandoff() {
  // The worker also pings us once the hand-off is stored; run one claim at a time.
  if (claiming) return;
  claiming = true;
  try {
    await claimHandoffOnce();
  } finally {
    claiming = false;
  }
}

async function claimHandoffOnce() {
  // On a sign-in page, leave the hand-off queued; it's claimed after login.
  if (/\/(login|signin|sign-in|auth)\b/i.test(location.pathname)) {
    if (await send({ type: 'HAS_PENDING' })) toast(`Sign in to ${adapter.name} — your context will be added right after.`, { duration: 10_000 });
    return;
  }
  // The worker may still be recording the pending entry; check a few times.
  let queued = false;
  for (const delay of [0, 800, 2000, 4000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    queued = await send({ type: 'HAS_PENDING' });
    if (queued) break;
  }
  if (!queued) return;

  // Only claim once this page really has a message box. Interstitials such as
  // bot checks or sign-in walls keep the hand-off queued for the next page.
  toast(`Waiting for ${adapter.name} to load…`, { busy: true });
  try {
    await waitForComposer(adapter, 60_000);
  } catch {
    hideToast();
    return;
  }
  const pending = await send({ type: 'CLAIM_PENDING' });
  if (!pending) {
    hideToast();
    return;
  }

  const { text, handoffId } = pending;
  const copyAction = {
    label: 'Copy context',
    run: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied. Paste it into the message box with Ctrl/Cmd + V.');
      } catch {
        toast('Your browser blocked copying. Open the ContextPort library to copy it.');
      }
    },
  };

  toast(`Adding your context to ${adapter.name}…`, { busy: true });
  try {
    const composer = await waitForComposer(adapter);
    // Let the page finish hydrating so our text isn't wiped by its own init.
    await new Promise((r) => setTimeout(r, 700));
    const box = adapter.composer() || composer;
    let mode = 'replace';
    const draft = composerText(box).trim();
    if (draft) {
      hideToast();
      mode = await askAboutDraft(draft, adapter.name);
      if (mode === 'cancel') {
        toast('Transfer paused. You can copy the context instead.', { action: copyAction });
        send({ type: 'REPORT', handoffId, status: 'canceled' });
        return;
      }
    }
    const result = await insertText(box, text, mode);
    await send({ type: 'REPORT', handoffId, status: result === 'verified' ? 'delivered' : 'inserted' });
    // After a few successful transfers, ask once for a store review.
    const review = await send({ type: 'REVIEW_CHECK' });
    if (review?.url) {
      toast('Context added. Enjoying ContextPort? A quick rating helps a lot.', {
        duration: 12_000,
        action: { label: 'Rate it ★', run: () => window.open(review.url, '_blank', 'noopener') },
      });
    } else {
      toast('Context added. Review it, then press send.', { duration: 6000 });
    }
  } catch (err) {
    const signedOut = /login|signin|sign-in|auth/.test(location.pathname);
    toast(signedOut ? `Sign in to ${adapter.name}, then use Copy context.` : `${err.message}. You can paste it yourself.`, { action: copyAction });
    send({ type: 'REPORT', handoffId, status: 'failed' });
  }
}
