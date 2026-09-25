import { useEffect, useState } from 'react';
import { formatHandoff } from '../../../shared/format.js';
import { PLATFORMS } from '../../../shared/constants.js';
import { Icon } from '../ui.jsx';

const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** Decrypts a share link entirely in the browser. The key (#fragment) never reaches the server. */
async function openShare(id, keyB64) {
  const res = await fetch(`/api/v1/shares/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? 'This link has expired or was revoked.' : 'Could not load this link.');
  const { ciphertext, iv } = await res.json();
  const key = await crypto.subtle.importKey('raw', b64urlToBytes(keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(iv) }, key, b64urlToBytes(ciphertext));
  const packet = JSON.parse(new TextDecoder().decode(plain));
  if (!packet || !packet.source || !PLATFORMS[packet.source.platform]) throw new Error('This link is not a ContextPort brief.');
  return packet;
}

function List({ items, ordered }) {
  if (!items?.length) return null;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag>
      {items.map((x, i) => (
        <li key={i}>{String(x)}</li>
      ))}
    </Tag>
  );
}

function Section({ title, children }) {
  if (!children || (Array.isArray(children) && !children.filter(Boolean).length)) return null;
  return (
    <>
      <h4>{title}</h4>
      {children}
    </>
  );
}

function Brief({ packet }) {
  if (packet.mode === 'full') {
    return (
      <div className="brief">
        {(packet.messages || []).map((m, i) => (
          <div key={i}>
            <h4>{m.role === 'user' ? 'User' : PLATFORMS[packet.source.platform].name}</h4>
            <p>{m.content}</p>
          </div>
        ))}
      </div>
    );
  }
  const b = packet.brief || {};
  return (
    <div className="brief">
      <h3>{b.title || 'Conversation brief'}</h3>
      <Section title="Goal">{b.goal && <p>{b.goal}</p>}</Section>
      <Section title="What happened">{b.summary && <p>{b.summary}</p>}</Section>
      <Section title="Requirements">{b.userPreferences?.length ? <List items={b.userPreferences} /> : null}</Section>
      <Section title="Key facts">{b.keyFacts?.length ? <List items={b.keyFacts} /> : null}</Section>
      <Section title="Decisions">{b.decisions?.length ? <List items={b.decisions} /> : null}</Section>
      <Section title="Tried so far">{b.attempts?.length ? <List items={b.attempts} /> : null}</Section>
      <Section title="Where it stands">{b.currentState && <p>{b.currentState}</p>}</Section>
      <Section title="Next steps">{b.nextSteps?.length ? <List items={b.nextSteps} ordered /> : null}</Section>
      <Section title="Open questions">{b.openQuestions?.length ? <List items={b.openQuestions} /> : null}</Section>
      {packet.code?.length ? (
        <>
          <h4>Code</h4>
          {packet.code.map((c, i) => (
            <div key={i}>
              {c.lang && <div className="lang">{c.lang}</div>}
              <pre>{c.code}</pre>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

export default function Share() {
  const [state, setState] = useState({ status: 'loading' });
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const id = window.location.pathname.split('/').pop();
    const key = window.location.hash.slice(1);
    if (!key) {
      setState({ status: 'error', message: 'This link is missing its key. Ask for the complete link — everything after the “#” is needed to read it.' });
      return;
    }
    openShare(id, key)
      .then((packet) => setState({ status: 'ok', packet }))
      .catch((err) => setState({ status: 'error', message: err.name === 'OperationError' ? 'This link is damaged or incomplete.' : err.message }));
  }, []);

  async function continueIn(dest) {
    const text = formatHandoff(state.packet, dest);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(dest);
    } catch {
      setCopied('');
    }
    window.open(PLATFORMS[dest].newChatUrl, '_blank', 'noopener');
  }

  return (
    <>
      <section className="page-head">
        <div className="orb" />
        <div className="wrap">
          <p className="eyebrow">Shared with ContextPort</p>
          <h1 className="display d-xl" style={{ marginTop: 12 }}>
            {state.status === 'ok' ? state.packet.brief?.title || state.packet.source.title || 'A shared AI conversation' : state.status === 'loading' ? 'Opening the brief…' : 'Can’t open this link'}
          </h1>
          {state.status === 'ok' && (
            <p className="lead">
              A brief of a {PLATFORMS[state.packet.source.platform].name} conversation. Continue it in your own AI — the full context comes with it.
            </p>
          )}
        </div>
      </section>
      <section className="wrap share-body">
        {state.status === 'loading' && <div className="card">Decrypting in your browser…</div>}
        {state.status === 'error' && (
          <div className="card">
            <p>{state.message}</p>
            <a className="btn primary" href="/" style={{ marginTop: 16 }}>
              What is ContextPort?
            </a>
          </div>
        )}
        {state.status === 'ok' && (
          <div className="share-grid">
            <article className="card">
              <Brief packet={state.packet} />
            </article>
            <aside className="share-side">
              <div className="card">
                <h3>Continue in</h3>
                <p className="muted small">We copy the brief and open a new chat. Paste it with Ctrl/Cmd + V.</p>
                <div className="stack">
                  {['claude', 'chatgpt', 'gemini'].map((d) => (
                    <button key={d} className={`btn${d === 'claude' ? ' primary' : ''}`} onClick={() => continueIn(d)}>
                      {copied === d ? 'Copied — paste it' : `Continue in ${PLATFORMS[d].name}`} <Icon name="arrow" />
                    </button>
                  ))}
                </div>
              </div>
              <div className="card soft">
                <h3>Do this yourself</h3>
                <p className="muted small">ContextPort moves any chat between ChatGPT, Claude and Gemini with one click — and inserts it for you.</p>
                <a className="btn" href="/install">
                  Get ContextPort free
                </a>
              </div>
              <p className="muted small">
                <Icon name="lock" /> End-to-end encrypted. The key is in this link; ContextPort’s servers can’t read it.
              </p>
            </aside>
          </div>
        )}
      </section>
    </>
  );
}
