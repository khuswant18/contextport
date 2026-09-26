import { useState } from 'react';

function Stat({ label, value, hint }) {
  return (
    <div className="card stat">
      <p className="eyebrow">{label}</p>
      <div className="stat-value">{value ?? '—'}</div>
      {hint && <p className="muted small">{hint}</p>}
    </div>
  );
}

/** Private metrics dashboard. Requires ADMIN_TOKEN (kept only in this tab's memory). */
export default function Admin() {
  const [token, setToken] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  async function load(e) {
    e?.preventDefault();
    setError('');
    const res = await fetch('/api/v1/admin/stats', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!res.ok) return setError(res.status === 401 ? 'Wrong token.' : res.status === 404 ? 'Admin API is disabled (set ADMIN_TOKEN on the server).' : 'Could not load stats.');
    setData(await res.json());
  }

  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  return (
    <section className="wrap admin">
      <p className="eyebrow" style={{ marginTop: 48 }}>Admin</p>
      <h1 className="display d-xl">Engagement</h1>
      {!data && (
        <form className="card admin-login" onSubmit={load}>
          <label htmlFor="tok">Admin token</label>
          <input id="tok" className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn primary" type="submit">View metrics</button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
      {data && (
        <>
          <div className="grid-4">
            <Stat label="Installs · all time" value={data.totals.installs.toLocaleString()} hint={`${data.totals.installsToday} today`} />
            <Stat label="Downloads · all time" value={data.totals.downloads.toLocaleString()} hint={`${data.totals.downloadsToday} today · one per network per day`} />
            <Stat label="Download → install" value={pct(data.totals.downloadToInstall)} hint="Installs ÷ downloads" />
            <Stat label="Active users · 7 days" value={data.activeDevicesLast7d.toLocaleString()} hint="Made at least one transfer" />
          </div>
          <div className="grid-4">
            <Stat label="Activation" value={pct(data.activationRate)} hint="First transfer within 24h of install" />
            <Stat label="D7 retention" value={pct(data.retentionD7)} hint="Active again after a week" />
            <Stat label="D30 retention" value={pct(data.retentionD30)} hint="Active again after a month" />
            <Stat label="Transfers / active user / week" value={data.transfersPerActivePerWeek} hint={`${data.transfersLast7d} transfers by ${data.activeDevicesLast7d} users`} />
          </div>
          <div className="grid-2">
            <div className="card">
              <h3>Feature use · last 7 days</h3>
              <table className="table">
                <tbody>
                  {data.featureUseLast7d.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name.replace(/_/g, ' ')}</td>
                      <td className="num">{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
              <h3>Downloads & installs · last 30 days</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Downloads</th>
                    <th className="num">Installs</th>
                  </tr>
                </thead>
                <tbody>
                  {data.installsByDay.length === 0 && (
                    <tr>
                      <td colSpan={3}>No downloads or installs yet.</td>
                    </tr>
                  )}
                  {data.installsByDay.map((r) => (
                    <tr key={r.day}>
                      <td>{r.day}</td>
                      <td className="num">{r.downloads}</td>
                      <td className="num">{r.installs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <h3>Hosted AI today</h3>
              <p className="stat-value">{data.hostedToday.requests}</p>
              <p className="muted small">{Number(data.hostedToday.tokens).toLocaleString()} tokens</p>
            </div>
          </div>
          <button className="btn" onClick={load} style={{ margin: '24px 0 96px' }}>
            Refresh
          </button>
        </>
      )}
    </section>
  );
}
