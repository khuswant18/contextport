import { useEffect, useState } from 'react';

function Stat({ label, value, hint }) {
  return (
    <div className="card stat">
      <p className="eyebrow">{label}</p>
      <div className="stat-value">{value ?? '—'}</div>
      {hint && <p className="muted small">{hint}</p>}
    </div>
  );
}

function CountTable({ title, rows, label, empty, mono }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <table className="table">
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td className="empty">{empty}</td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r[label]}>
              <td className={mono ? 'path' : undefined}>{mono ? r[label] : r[label].replace(/_/g, ' ')}</td>
              <td className="num">{r.n.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Private metrics dashboard. Nothing is shown until the server accepts the
 * admin sign-in; the session lives in an HttpOnly cookie scoped to the admin API.
 */
export default function Admin() {
  const [status, setStatus] = useState('checking'); // checking | login | ready
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    const res = await fetch('/api/v1/admin/stats', { cache: 'no-store' }).catch(() => null);
    if (res?.status === 401) {
      setData(null);
      return setStatus('login');
    }
    if (!res?.ok) {
      setError('Could not load stats. Try again in a moment.');
      return setStatus((s) => (s === 'checking' ? 'login' : s));
    }
    setData(await res.json());
    setStatus('ready');
  }

  useEffect(() => {
    load();
  }, []);

  async function signIn(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/v1/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }).catch(() => null);
      if (!res?.ok) {
        return setError(
          res?.status === 401 ? 'Wrong username or password.' : res?.status === 429 ? 'Too many attempts. Try again in 15 minutes.' : 'Could not sign in. Try again.',
        );
      }
      setPassword('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch('/api/v1/admin/logout', { method: 'POST' }).catch(() => {});
    setData(null);
    setStatus('login');
  }

  if (status === 'checking') {
    return (
      <section className="wrap admin">
        <p className="muted" style={{ marginTop: 48 }}>Loading…</p>
      </section>
    );
  }

  if (status === 'login' || !data) {
    return (
      <section className="wrap admin">
        <p className="eyebrow" style={{ marginTop: 48 }}>Admin</p>
        <h1 className="display d-xl">Sign in</h1>
        <form className="card admin-login" onSubmit={signIn}>
          <label htmlFor="admin-user">Username</label>
          <input id="admin-user" className="input" autoComplete="username" autoCapitalize="none" spellCheck="false" required value={username} onChange={(e) => setUsername(e.target.value)} />
          <label htmlFor="admin-pass">Password</label>
          <input id="admin-pass" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      </section>
    );
  }

  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const n = (v) => Number(v || 0).toLocaleString();
  const t = data.traffic;
  return (
    <section className="wrap admin">
      <div className="admin-head" style={{ marginTop: 48 }}>
        <div>
          <p className="eyebrow">Admin · {data.environment}</p>
          <h1 className="display d-xl">Dashboard</h1>
        </div>
        <div className="admin-actions">
          <button className="btn small" onClick={load}>Refresh</button>
          <button className="btn small" onClick={signOut}>Sign out</button>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      <h2 className="eyebrow admin-section">Website traffic</h2>
      <div className="grid-4">
        <Stat label="Visitors · today" value={n(t.visitorsToday)} hint={`${n(t.viewsToday)} page views today`} />
        <Stat label="Visitors · 30 days" value={n(t.visitors30d)} hint="Unique per network per day, summed" />
        <Stat label="Page views · 30 days" value={n(t.views30d)} hint={`${n(t.viewsTotal)} all time`} />
        <Stat label="Visit → download · 30 days" value={pct(t.visitToDownload30d)} hint="Downloads ÷ visitors" />
      </div>

      <h2 className="eyebrow admin-section">Downloads & installs</h2>
      <div className="grid-4">
        <Stat label="Downloads · all time" value={n(data.totals.downloads)} hint={`${data.totals.downloadsToday} today · one per network per day`} />
        <Stat label="Installs · all time" value={n(data.totals.installs)} hint={`${data.totals.installsToday} today`} />
        <Stat label="Download → install" value={pct(data.totals.downloadToInstall)} hint="Installs ÷ downloads" />
        <Stat label="Active users · 7 days" value={n(data.activeDevicesLast7d)} hint="Made at least one transfer" />
      </div>

      <h2 className="eyebrow admin-section">Engagement</h2>
      <div className="grid-4">
        <Stat label="Activation" value={pct(data.activationRate)} hint="First transfer within 24h of install" />
        <Stat label="D7 retention" value={pct(data.retentionD7)} hint="Active again after a week" />
        <Stat label="D30 retention" value={pct(data.retentionD30)} hint="Active again after a month" />
        <Stat label="Transfers / active user / week" value={data.transfersPerActivePerWeek} hint={`${data.transfersLast7d} transfers by ${data.activeDevicesLast7d} users`} />
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Daily · last 30 days</h3>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Visitors</th>
                  <th className="num">Views</th>
                  <th className="num">Downloads</th>
                  <th className="num">Installs</th>
                </tr>
              </thead>
              <tbody>
                {data.installsByDay.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">No traffic yet.</td>
                  </tr>
                )}
                {data.installsByDay.map((r) => (
                  <tr key={r.day}>
                    <td>{r.day}</td>
                    <td className="num">{r.visitors}</td>
                    <td className="num">{r.views}</td>
                    <td className="num">{r.downloads}</td>
                    <td className="num">{r.installs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <CountTable title="Top pages · 30 days" rows={t.topPages30d} label="path" empty="No page views yet." mono />
          <CountTable title="Top referrers · 30 days" rows={t.topReferrers30d} label="host" empty="No referring sites yet." mono />
        </div>
        <CountTable title="Feature use · last 7 days" rows={data.featureUseLast7d} label="name" empty="No events yet." />
        <div className="card">
          <h3>Brief ratings · 30 days</h3>
          <p className="stat-value">{pct(data.feedback30d.satisfaction)}</p>
          <p className="muted small">
            {data.feedback30d.up} 👍 · {data.feedback30d.down} 👎
          </p>
          <table className="table">
            <tbody>
              {data.feedback30d.reasons.map((r) => (
                <tr key={r.reason}>
                  <td>{r.reason.replace(/_/g, ' ')}</td>
                  <td className="num">{r.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Hosted AI today</h3>
          <p className="stat-value">{data.hostedToday.requests}</p>
          <p className="muted small">{n(data.hostedToday.tokens)} tokens</p>
        </div>
      </div>
      <div style={{ height: 96 }} />
    </section>
  );
}
