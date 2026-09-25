import InstallGuide, { DownloadButton, INSTALL_FAQ } from '../InstallGuide.jsx';

export default function Install() {
  const ref = new URLSearchParams(window.location.search).get('ref') || '';
  const code = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i.test(ref) ? ref.toUpperCase() : '';
  return (
    <>
      {code && (
        <div className="wrap">
          <div className="callout invite-callout">
            <strong>You were invited!</strong> After installing, open ContextPort Settings → Invite friends and enter <code>{code}</code> — you’ll both get extra free transfers every day.
          </div>
        </div>
      )}
      <section className="page-head">
        <div className="orb" />
        <div className="wrap">
          <p className="eyebrow">Install</p>
          <h1 className="display d-xl" style={{ marginTop: 12 }}>Add ContextPort to Chrome</h1>
          <p className="lead">Works in Chrome, Edge, Brave, Arc and other Chromium browsers. Takes about a minute.</p>
          <div style={{ display: 'flex', gap: 10, marginTop: 28, flexWrap: 'wrap' }}>
            <DownloadButton />
            <a className="btn" href="#trouble">Install problems?</a>
          </div>
        </div>
      </section>
      <section className="wrap prose">
        <h2>Install in four steps</h2>
        <InstallGuide />

        <h2>Your first transfer</h2>
        <ol>
          <li>Open a conversation in ChatGPT, Claude, Gemini or Perplexity.</li>
          <li>Click the round <strong>Transfer</strong> button at the bottom-right, the toolbar icon, or press <span className="kbd">Alt</span> + <span className="kbd">Shift</span> + <span className="kbd">T</span>.</li>
          <li>Choose where to continue, check the brief, and click <strong>Open</strong>.</li>
          <li>The new chat opens with the brief in the message box. Review it and press send.</li>
        </ol>

        <h2 id="trouble">If something goes wrong</h2>
        <div className="faq">
          {INSTALL_FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>

        <h2>Permissions, explained</h2>
        <ul>
          <li><strong>Read and change data on ChatGPT, Claude, Gemini and Perplexity</strong> — to read the conversation you choose to transfer and to fill in the message box of the destination.</li>
          <li><strong>Storage</strong> — to keep your settings and transfer history on your device.</li>
          <li><strong>Side panel</strong> — for the Library of past transfers.</li>
          <li>If you add your own API key, Chrome asks once for permission to contact that provider only.</li>
        </ul>
      </section>
    </>
  );
}
