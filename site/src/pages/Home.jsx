import { Icon } from '../ui.jsx';
import InstallGuide, { DownloadButton } from '../InstallGuide.jsx';

function ProductMock() {
  return (
    <div className="mock-wrap" aria-hidden="true">
      <div className="mock">
        <div className="mock-chat">
          <div className="bubble u">My invoice PDFs show ₹ as a blank box and totals like 117.99999. Must stay on Vercel's free plan.</div>
          <div className="bubble a">
            Two issues. Your Inter file is the latin subset without U+20B9 — use the full TTF. For rounding, store money as integer paise:
          </div>
          <div className="mock-code">{`const toPaise = (r: number) => Math.round(r * 100);
const fmt = (p: number) => '₹' + (p / 100)
  .toLocaleString('en-IN', { minimumFractionDigits: 2 });`}</div>
          <div className="bubble u">Should we migrate the Prisma money fields to Int now or later? We have ~2k invoices.</div>
        </div>
        <div className="mock-sheet">
          <p className="eyebrow">Transfer from ChatGPT</p>
          <h3>Continue this chat elsewhere</h3>
          <div className="mock-dests">
            <div className="mock-dest on"><span className="mono">Cl</span>Claude</div>
            <div className="mock-dest"><span className="mono">Ge</span>Gemini</div>
            <div className="mock-dest"><span className="mono">Px</span>Perplexity</div>
          </div>
          <div className="mock-brief">
            <b>Goal</b>
            <span>Fix ₹ rendering and float rounding in invoice PDFs, then decide on the paise migration.</span>
            <b>Your requirements</b>
            <span>Vercel free plan · no Redis · GST 18% as its own line</span>
            <b>Where it stands</b>
            <span>Font confirmed as a 98 KB subset; migration timing is the open question.</span>
            <b>Code</b>
            <span>3 blocks kept exactly</span>
          </div>
          <div className="mock-go">Open in Claude <Icon name="arrow" /></div>
        </div>
      </div>
    </div>
  );
}

const PROBLEMS = [
  ['limit', 'You hit a limit mid-task', 'Message caps and context limits arrive at the worst moment. Keep going in another assistant in seconds.'],
  ['compare', 'The chat got long and slow', 'Very long threads lag and answers drift. Start a fresh chat with a brief of everything that matters.'],
  ['spark', 'Another AI is better at this', 'Research in Perplexity, write in Claude, code in ChatGPT. Move between them without re-explaining.'],
];

const FEATURES = [
  ['download', 'Bring context into any chat', 'Open a new, empty chat and insert a brief you saved or sent before — no copy-paste.'],
  ['limit', 'Limit rescue', 'Hit a usage limit? ContextPort notices and offers to continue in another assistant, right there.'],
  ['transfer', 'Fresh start, same AI', 'When a thread gets too long, start a new chat on the same AI with a brief of everything so far.'],
  ['code', 'Checkpoints & projects', 'Save briefs as checkpoints, group them into projects, and continue a whole project anywhere with its history.'],
  ['eye', 'About me & snippets', 'Keep a short card about you and your favourite prompts. Type // in any chat box to use them.'],
  ['lock', 'Encrypted share links', 'Send a teammate a link to your brief. It’s end-to-end encrypted, expires in 7 days, and can be revoked.'],
];

const STEPS = [
  ['Click Transfer', 'On any ChatGPT, Claude, Gemini or Perplexity chat, click the Transfer button — or press Alt+Shift+T.'],
  ['Review the brief', 'ContextPort writes a clear brief of the whole conversation in a few seconds. Edit anything you like.'],
  ['Keep working', 'Pick the destination. It opens in a new tab with the brief in the message box. You press send.'],
];

export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="orb a" />
        <div className="orb b" />
        <div className="orb c" />
        <div className="wrap hero-inner">
          <p className="eyebrow">A Chrome extension for people who use more than one AI</p>
          <h1 className="display d-mega">Move any AI chat. Keep every detail.</h1>
          <p className="lead">
            ContextPort turns a long conversation into a clear brief — your goal, requirements, decisions, where you left off, and the exact
            code — and opens it in the assistant you want to continue with.
          </p>
          <div className="hero-ctas">
            <a className="btn primary" href="#install">
              Get it free for Chrome
            </a>
            <a className="btn" href="#how">
              See how it works
            </a>
          </div>
          <div className="platforms" aria-label="Supported assistants">
            {['ChatGPT', 'Claude', 'Gemini', 'Perplexity'].map((p) => (
              <span className="pill" key={p}>{p}</span>
            ))}
          </div>
        </div>
        <div className="wrap">
          <ProductMock />
        </div>
      </section>

      <section className="section tight">
        <div className="wrap">
          <div className="grid-3">
            {PROBLEMS.map(([icon, title, body]) => (
              <article className="card" key={title}>
                <div className="icon-chip"><Icon name={icon} /></div>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="wrap">
          <div className="section-head">
            <p className="eyebrow">How it works</p>
            <h2 className="display d-xl" style={{ marginTop: 12 }}>Three clicks, no copy-paste</h2>
            <p className="lead">Nothing is ever sent for you. You always see exactly what the next assistant will read.</p>
          </div>
          <div className="steps">
            {STEPS.map(([title, body], i) => (
              <div className="step" key={title}>
                <div className="n">{i + 1}</div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap brief-demo">
          <div>
            <p className="eyebrow">What's in the brief</p>
            <h2 className="display d-xl" style={{ marginTop: 12 }}>Not a summary. A handover.</h2>
            <p className="lead" style={{ margin: '14px 0 28px' }}>
              A one-line summary loses the details that matter. ContextPort keeps what the next assistant needs to carry on as if it had been there.
            </p>
            <dl className="brief-list">
              <div><dt>Goal</dt><dd>What you're ultimately trying to achieve.</dd></div>
              <div><dt>Requirements</dt><dd>Every constraint you stated — budgets, platforms, "don't use X".</dd></div>
              <div><dt>Decisions</dt><dd>What was chosen, and why.</dd></div>
              <div><dt>Tried so far</dt><dd>Approaches attempted and what happened.</dd></div>
              <div><dt>Where it stands</dt><dd>What works, what's broken, the latest question.</dd></div>
              <div><dt>Exact code</dt><dd>Copied character-for-character — never paraphrased.</dd></div>
            </dl>
          </div>
          <div className="compare">
            <div className="compare-row old">
              <p className="eyebrow">Typical summary</p>
              <p>"The user asked for help with their invoice app and the assistant explained some fixes."</p>
            </div>
            <div className="compare-row new">
              <p className="eyebrow">ContextPort brief</p>
              <pre>{`## Goal
Stable DB connections on Vercel and correct invoice PDFs
(₹ glyph, rounding), then decide on the paise migration.

## My requirements
- Must stay on Vercel's free plan
- Don't add Redis
- GST at 18% shown as a separate line

## Where we are now
Pooled Neon URL + pgbouncer=true fixed the deploy.
Font is a 98 KB subset without ₹. Money is still Float.

## Next steps
1. Swap in the full Inter TTF
2. Plan Float → Int (paise) for ~2k existing invoices`}</pre>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="features">
        <div className="wrap">
          <div className="section-head">
            <p className="eyebrow">Every day, not just at the limit</p>
            <h2 className="display d-xl" style={{ marginTop: 12 }}>One toolkit across all your AIs</h2>
            <p className="lead">The things you do between assistants, done in one click.</p>
          </div>
          <div className="grid-3 features">
            {FEATURES.map(([icon, title, body]) => (
              <article className="card" key={title}>
                <div className="icon-chip"><Icon name={icon} /></div>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="engines">
        <div className="wrap">
          <div className="section-head center" style={{ textAlign: 'center' }}>
            <p className="eyebrow">AI engines</p>
            <h2 className="display d-xl" style={{ marginTop: 12 }}>Free to start. Yours to control.</h2>
            <p className="lead">Choose what writes your brief. Switch any time in Settings.</p>
          </div>
          <div className="grid-3">
            <div className="tier featured">
              <span className="badge">Default</span>
              <h3>ContextPort AI</h3>
              <div className="price">Free</div>
              <p>Works the moment you install. No account, no key.</p>
              <ul>
                <li><Icon name="check" />Daily free transfers</li>
                <li><Icon name="check" />Conversations are not stored</li>
                <li><Icon name="check" />Best for everyday chats</li>
              </ul>
            </div>
            <div className="tier">
              <span className="badge">Unlimited</span>
              <h3>Your own API key</h3>
              <div className="price">Your plan</div>
              <p>Bring OpenAI, Anthropic, Google Gemini, Groq or OpenRouter.</p>
              <ul>
                <li><Icon name="check" />No daily limit</li>
                <li><Icon name="check" />Handles very long chats</li>
                <li><Icon name="check" />Key stays in your browser</li>
              </ul>
            </div>
            <div className="tier">
              <span className="badge">Private</span>
              <h3>Offline</h3>
              <div className="price">No AI</div>
              <p>A basic brief built on your device — nothing sent to any AI service.</p>
              <ul>
                <li><Icon name="check" />Goal, latest reply and requests</li>
                <li><Icon name="check" />Exact code included</li>
                <li><Icon name="check" />Or send the full transcript</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="privacy">
        <div className="wrap">
          <div className="orb-card">
            <div className="orb" />
            <div className="orb two" />
            <p className="eyebrow">Privacy</p>
            <h2 className="display d-xl" style={{ marginTop: 12, maxWidth: 640 }}>Your conversations stay yours</h2>
            <div className="privacy-points">
              <div><h3>No account, no cloud copy</h3><p>Your transfer history lives only in your browser. Delete it any time.</p></div>
              <div><h3>Nothing auto-sent</h3><p>ContextPort only fills in the message box. You review and press send.</p></div>
              <div><h3>Not stored by us</h3><p>ContextPort AI reads a conversation only to write its brief, then forgets it. We keep anonymous usage counts, nothing else.</p></div>
              <div><h3>Keys never leave your browser</h3><p>With your own key, requests go straight from your browser to your provider.</p></div>
            </div>
            <a className="text-link" href="/privacy" style={{ display: 'inline-block', marginTop: 28 }}>Read the privacy policy</a>
          </div>
        </div>
      </section>

      <section className="section" id="install">
        <div className="wrap install-home">
          <div className="section-head">
            <p className="eyebrow">Install</p>
            <h2 className="display d-xl" style={{ marginTop: 12 }}>Up and running in a minute</h2>
            <p className="lead">
              ContextPort isn’t in the Chrome Web Store yet, so you add it yourself — four quick steps. Works in Chrome, Edge, Brave, Arc and
              other Chromium browsers.
            </p>
          </div>
          <InstallGuide />
          <p className="install-more">
            Stuck? <a className="text-link" href="/install#trouble">See fixes for common install problems</a>.
          </p>
        </div>
      </section>

      <section className="cta-band">
        <div className="orb" />
        <p className="eyebrow">Get started</p>
        <h2 className="display d-lg" style={{ marginTop: 12 }}>Stop re-explaining yourself to every AI.</h2>
        <DownloadButton label="Download ContextPort — free" />
      </section>
    </>
  );
}
