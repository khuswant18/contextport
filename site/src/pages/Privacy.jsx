export default function Privacy() {
  return (
    <>
      <section className="page-head">
        <div className="orb" />
        <div className="wrap">
          <p className="eyebrow">Legal</p>
          <h1 className="display d-xl" style={{ marginTop: 12 }}>Privacy policy</h1>
          <p className="lead">Plain-language summary of what ContextPort does with your data. Last updated September 2026.</p>
        </div>
      </section>
      <article className="wrap prose">
        <h2>The short version</h2>
        <ul>
          <li>We do not sell, share or use your conversations for advertising or training.</li>
          <li>There is no ContextPort account. Your transfer history is stored only in your browser.</li>
          <li>ContextPort AI processes a conversation only to write its brief and does not store it.</li>
          <li>Your API keys, if you add them, never leave your browser except to go to the provider you chose.</li>
        </ul>

        <h2>What the extension reads</h2>
        <p>
          When you open the Transfer panel, the extension reads the messages of the conversation on that page (ChatGPT, Claude, Gemini or
          Perplexity) so it can prepare the brief. It does not read other tabs or websites, and does nothing on AI sites until you use it —
          except checking whether a transfer is waiting to be inserted.
        </p>

        <h2>Where your conversation goes</h2>
        <h3>ContextPort AI (default)</h3>
        <p>
          The selected messages are sent over an encrypted connection to the ContextPort service, which uses an AI model provider to write
          the brief and returns it to your browser. The conversation is not written to our database or logs. We store an anonymous install
          identifier (only a one-way hash of it), daily usage counts, and a keyed hash of your IP address used to prevent abuse.
        </p>
        <h3>Your own API key</h3>
        <p>
          The conversation is sent directly from your browser to the provider you chose (for example OpenAI or Anthropic), under that
          provider's terms. ContextPort's servers are not involved.
        </p>
        <h3>Offline</h3>
        <p>The brief is built on your device. Nothing is sent to any AI service other than the destination assistant you open.</p>

        <h2>Share links</h2>
        <p>
          When you create a share link, the brief is encrypted in your browser with a new random key. Our server stores only the encrypted
          data; the key is the part of the link after the “#”, which browsers never send to servers. Anyone you give the full link to can
          read it; we can’t. Links expire after 7 days and you can revoke them in the Library at any time.
        </p>

        <h2>Anonymous usage statistics</h2>
        <p>
          To learn which features help, the extension sends counts of events such as “a transfer happened”, with small fixed labels like
          which AI it came from and went to. It never sends conversation text, titles, links or anything you typed. You can turn this off
          in Settings → Privacy &amp; data. Brief ratings (thumbs up/down and reasons like “missing code”) work the same way.
        </p>

        <h2>Website analytics</h2>
        <p>
          This website uses Vercel Web Analytics to count page views. It uses no cookies and doesn’t track you across sites; it records the
          page path, referrer, country and device type. Share-link pages and the admin page are never reported, and links are sent without
          anything after the “?” or “#”. The extension itself doesn’t use it.
        </p>
        <p>
          We also keep our own daily totals: page views per page (share links are counted as one page, never by ID), the number of
          unique visitors per day, and the name of the website that linked to us (for example “google.com”, never the full address).
          To count a visitor once per day we store a one-way keyed hash of the network address, deleted after two days. No cookies are set.
        </p>

        <h2>Invites</h2>
        <p>Invite codes are random and linked only to an anonymous install. We store which install invited which, to add bonus transfers.</p>

        <h2>What stays on your device</h2>
        <p>
          Settings, your transfer history (the briefs and text you sent) and any API keys are stored in the extension's private browser
          storage, which websites cannot access. You can export or delete your history in Settings, and uninstalling the extension removes
          everything.
        </p>

        <h2>Data retention</h2>
        <p>Daily usage counters are deleted after 60 days, IP hashes after 7 days, usage events after 180 days, ratings after a year, and share links as soon as they expire.</p>

        <h2>Contact</h2>
        <p>Questions or deletion requests: use the contact address listed on the ContextPort store page.</p>
      </article>
    </>
  );
}
