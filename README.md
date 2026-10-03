# ContextPort

Move a conversation between ChatGPT, Claude, Gemini and Perplexity without starting over. ContextPort reads the chat, writes a structured brief (goal, requirements, decisions, attempts, current state, next steps) and re-attaches the **exact** code blocks. It then opens the destination with the brief already in the message box. It never sends the message for you.

```
contextport/
├─ shared/      Engine used by the server and the extension (transcript, prompt, brief, formatting)
├─ server/      Node API (hosted AI via Groq, Neon Postgres quotas) + serves the website
├─ extension/   Chrome MV3 extension (src/ → dist/ via esbuild)
├─ site/        Marketing website (Vite + React)
└─ tests/       Playwright end-to-end tests + fixtures
```

## How a transfer works

1. **Read.** A content script converts the chat's DOM to Markdown. Code fences, lists and tables survive, and buttons and hidden labels are skipped.
2. **Pull code out.** Every fenced block is replaced by a marker such as `[[code #3: python, 12 lines]]`. The model sees only the markers, chooses which blocks matter, and the original code is re-attached character for character.
3. **Fit.** Long chats keep the opening request and the latest turns in full. Older middle turns are shortened first, then omitted.
4. **Brief.** One of three engines writes the brief:
   - **ContextPort AI** (default): the server calls Groq with your key. The provider is never shown to users.
   - **Your own key**: OpenAI, Anthropic, Gemini, Groq or OpenRouter, called directly from the browser.
   - **Offline**: no AI.

   If an engine fails, the panel says why and falls back to the offline brief.
5. **Hand off.** The destination tab claims the queued text only after its message box exists. This survives sign-in pages and bot checks, and the text is held for up to 10 minutes.

## Engagement features (v3.3)

| Area | What it does | Where |
|---|---|---|
| Activation | Welcome page with a live sample transfer, pin-to-toolbar check, one-time coachmark on first chat | `options/` (`#welcome`), `content/engage.js` |
| Moments of need | Detects usage-limit notices and very long chats and offers “continue elsewhere” / “start fresh with a brief” | `content/engage.js`, `adapters.js` (`findLimitNotice`) |
| Daily features | Launcher on every chat (empty chats included); insert a saved brief into any chat; fresh chat on the same AI; checkpoints; projects with “Continue project”; About me card; snippets (`//` or Alt+Shift+S); Markdown/Obsidian export | panel, Library, Settings |
| Value | “Saved you about N min this month”, what’s-new card after updates, store-review ask after the 3rd delivered transfer (once) | popup, destination toast |
| Growth | End-to-end encrypted share links (AES-256-GCM, key only in the URL `#fragment`, 7-day expiry, revocable); invite codes with +5/day for both people | `background/share.js`, `server/src/growth.js`, `site/src/pages/Share.jsx` |
| Quality | 👍/👎 with reason codes on every brief; Short / Standard / Detailed briefs | panel, `shared/prompt.js` |
| Measurement | Anonymous allowlisted events (no content, opt-out in Settings); admin metrics at `/admin`: activation, D7/D30 retention, transfers per active user per week, feature use, ratings | `background/telemetry.js`, `GET /api/v1/admin/stats` |

Anti-abuse on invites:
- Only installs up to 7 days old can redeem a code, and only once.
- A code can't be redeemed by its own install, or from the same network as the referrer.
- A referrer earns bonuses for at most 10 friends.

Admin metrics: open `https://your-domain/admin` and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` (defaults `admin` / `12345678`; set your own on the host). The session is an HttpOnly cookie, valid for 12 hours, and sign-in is limited to 10 attempts per 15 minutes per network. The dashboard covers website traffic (visitors, page views, top pages, referring sites), downloads, installs and engagement. Scripts can still call `GET /api/v1/admin/stats` with `Authorization: Bearer <ADMIN_TOKEN>` (32+ characters).

Store listing assets are generated with `node tools/store-assets.mjs` (the server must be running). It writes to `store-assets/`:
- 5 screenshots at 1280×800
- a 440×280 promo tile and a 1400×560 marquee
- demo videos, which you upload to YouTube for the listing

## Run locally

```bash
# 1. Server (reads server/.env)
cd server && npm install && npm start            # http://localhost:8787

# 2. Extension + website
cd .. && npm install
(cd extension && npm install) && (cd site && npm install)
npm run build                                    # extension/dist + site/dist + downloadable zip
```

Load `extension/dist` at `chrome://extensions`: turn on Developer mode, then click Load unpacked.

The extension talks to the server it was built for (`http://localhost:8787` by default). If that server isn't running, briefs fall back to the offline summary with the notice “ContextPort AI’s server isn’t responding right now”. Keep the server running while developing, or build against your deployed URL (see Deploy).

## Tests

| Command | What it covers |
|---|---|
| `node --test shared/test/*.test.js` | Engine: validation, code extraction, budgeting, output sanitising, formatting |
| `cd server && npm test` | API security: auth, CORS/origin, body limits, rate limits, quotas, path traversal, token hashing |
| `cd server && RUN_LIVE_MODEL_TEST=1 npm test` | The above plus real Groq calls (provider never leaked; a 141-message chat is trimmed and briefed) |
| `node tests/engagement.mjs` | 33 checks: menu, coachmark, launcher on empty chats, saved-brief insert, projects, About me, ratings, encrypted share + revoke, limit/long-chat nudges, snippets, review ask, popup, welcome demo, invites, events |
| `node tests/closed-shadow.mjs` (`ROUNDS=3` to repeat) | The **production** build with its closed shadow root, driven by real mouse clicks via the DevTools protocol: every menu item, click-outside, Escape, launcher returning after a transfer, saved-brief insert, and no main-thread stalls while typing/scrolling a 300-message chat |
| `GROQ_API_KEY=… PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 node tests/settings-byok.mjs` | Bring-your-own-key: provider switching, key auto-detect, model verification + suggestions, key never leaves for other hosts, network allowlist |
| `node tests/e2e.mjs` | Real Chromium with the extension against live ChatGPT and Gemini, plus Claude (see below), BYOK, fallback and the extension pages |

`tests/e2e.mjs` opens a visible browser window, because ChatGPT's bot check blocks headless browsers. Run the server first. Add `GROQ_API_KEY=…` to also run the bring-your-own-key test.

**Claude coverage:** claude.ai requires a login.
- **Claude as destination** is tested live against the real claude.ai message box.
- **Claude as source** is tested against a page with Claude's DOM selectors.

Verify the source side once with a signed-in account (checklist below).

## Deploy (one service: API + website)

1. Deploy the `Dockerfile` to Render, Railway, Fly.io or any container host.
2. Set the environment variables from `server/.env.example` in the host's secret settings, and set `TRUST_PROXY=1`. Never bake secrets into the image.
3. Put it behind HTTPS on your domain, for example `https://contextport.app`.
4. Build the extension against it:
   ```bash
   CONTEXTPORT_API=https://contextport.app npm run build
   ```
   Then upload `extension/dist`, zipped, to the Chrome Web Store. Use the website's privacy page as the listing's privacy policy.
5. After publishing, set `ALLOWED_EXTENSION_IDS=<your store extension id>` so the API rejects other extensions.

### Scaling to 300 users

The Groq key is on the **free tier**: about 8,000 tokens per minute per model, 1,000 requests per day, and 1,000 output tokens per minute on qwen. One brief uses about 2–7k tokens, so the hosted engine handles roughly **3–6 briefs per minute** in total. The server rotates models, queues requests, and shows "busy" instead of failing.

For 300 active users:

- **Upgrade Groq to the Developer (pay-as-you-go) tier.** It removes the per-minute bottleneck. Then raise `HOSTED_TRANSCRIPT_TOKENS` to about 20000 for better long-chat briefs.
- **Set `GLOBAL_DAILY_TOKENS`** as a hard daily spending cap.
- **Keep bring-your-own-key available** for heavy users, who bypass your quota entirely.
- **Neon's pooled connection is fine.** Each brief makes about 5 small queries.

## Security model

- **Secrets:**
  - The Groq key and database URL exist only in `server/.env` (mode 600, git-ignored) or the host's secret store.
  - The extension bundle contains none; the build is scanned for them.
- **Hosted API:**
  - Anonymous device tokens are 256-bit, and only their SHA-256 hash is stored.
  - Per-IP registration limits.
  - A per-device burst limit (6 per minute) and a daily quota enforced by atomic SQL.
  - A global daily token cap.
- **Request handling:**
  - A 1.5 MB body cap, JSON only, and schema validation.
  - Slow-client timeouts.
  - No CORS: websites can't call the API, and preflights and web origins get 403.
- **Privacy:**
  - Errors are generic, and logs never contain conversation text.
  - The database never stores conversations.
- **Model output** is treated as untrusted: it's bounded, validated, only http(s) links are kept, and it's rendered with `textContent` only. The prompt tells the model that the transcript is data, not instructions.
- **Extension:**
  - Only the extension's own pages can reach settings, keys and history. Content scripts get a narrow API, and web pages can't message the extension at all (no `externally_connectable`).
  - API keys and history are stored in the extension's IndexedDB, which pages and content scripts can't read, and keys are never sent back to any page.
  - Pending hand-offs sit in `storage.session`, which is trusted contexts only.
  - Provider domains are *optional* permissions, requested only when a user adds that key.
  - The in-page UI uses a closed shadow root, a strict extension CSP and no `innerHTML`.
- **Website:** a strict CSP (`script-src 'self'`, no inline code), HSTS, `frame-ancestors 'none'`, and path-traversal-safe static serving.

**Recommended hardening:**
- Rotate the Groq key and Neon password that were shared in chat.
- Create a Neon role with access only to the `cp_*` tables instead of `neondb_owner`.

## Manual check with signed-in accounts

1. **Claude:** open an existing chat that contains code, click **Transfer**, and confirm the brief lists the right goal and code. Send it to ChatGPT.
2. **ChatGPT (signed in):** open an existing chat, transfer it to Gemini, and confirm the brief is inserted.
3. **Draft protection:** type something in the destination's message box first, then transfer. You should be asked whether to add the brief below your draft or replace it.
