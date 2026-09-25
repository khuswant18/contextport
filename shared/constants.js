/**
 * Shared constants for the ContextPort engine (used by the server and the extension).
 */

export const PLATFORMS = {
  chatgpt: { id: 'chatgpt', name: 'ChatGPT', newChatUrl: 'https://chatgpt.com/' },
  claude: { id: 'claude', name: 'Claude', newChatUrl: 'https://claude.ai/new' },
  gemini: { id: 'gemini', name: 'Gemini', newChatUrl: 'https://gemini.google.com/app' },
  perplexity: { id: 'perplexity', name: 'Perplexity', newChatUrl: 'https://www.perplexity.ai/' },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

export const MODES = ['smart', 'full'];

/** Hard limits on what a client may send. Enforced on both sides. */
export const LIMITS = {
  maxMessages: 500,
  maxMessageChars: 120_000,
  maxTotalChars: 800_000,
  maxTitleChars: 300,
};

/** Rough token estimate that errs on the high side for mixed prose/code. */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 3.6);
}

export function platformName(id) {
  return PLATFORMS[id]?.name || 'another AI';
}

/** Brief length. `standard` adds no instruction; the others steer the model. */
export const DETAIL_LEVELS = ['short', 'standard', 'detailed'];

/** Anonymous usage events the extension may report (no content, ever). */
export const EVENT_NAMES = [
  'install',
  'update',
  'onboarding_demo',
  'panel_open',
  'brief_ready',
  'brief_failed',
  'handoff',
  'delivered',
  'delivery_failed',
  'checkpoint_saved',
  'resume',
  'share_created',
  'export',
  'snippet_used',
  'about_me_used',
  'limit_detected',
  'long_chat_nudge',
  'feedback',
  'referral_redeemed',
  'library_insert',
];
