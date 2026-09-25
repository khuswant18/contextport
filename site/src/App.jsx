import { useEffect, useState, useCallback } from 'react';
import Home from './pages/Home.jsx';
import Install from './pages/Install.jsx';
import Help from './pages/Help.jsx';
import Privacy from './pages/Privacy.jsx';
import Terms from './pages/Terms.jsx';
import Share from './pages/Share.jsx';
import Admin from './pages/Admin.jsx';
import { Icon } from './ui.jsx';

const ROUTES = {
  '/': { title: 'ContextPort — Move AI chats between ChatGPT, Claude & Gemini', Page: Home },
  '/install': { title: 'Install ContextPort', Page: Install },
  '/help': { title: 'Help & FAQ — ContextPort', Page: Help },
  '/privacy': { title: 'Privacy policy — ContextPort', Page: Privacy },
  '/terms': { title: 'Terms — ContextPort', Page: Terms },
};

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to) => {
    const url = new URL(to, window.location.origin);
    if (url.pathname !== window.location.pathname) window.history.pushState({}, '', url.pathname + url.hash);
    setPath(url.pathname);
    if (url.hash) requestAnimationFrame(() => document.querySelector(url.hash)?.scrollIntoView());
    else window.scrollTo({ top: 0 });
  }, []);
  return [path, navigate];
}

export default function App() {
  const [path, navigate] = usePath();
  const clean = path.replace(/\/+$/, '') || '/';
  const route = /^\/s\/[A-Za-z0-9_-]{22}$/.test(clean) ? { title: 'Shared brief — ContextPort', Page: Share } : clean === '/admin' ? { title: 'Admin — ContextPort', Page: Admin } : ROUTES[clean];
  const [menu, setMenu] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    document.title = route?.title || 'Page not found — ContextPort';
    setMenu(false);
  }, [route, path]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Intercept same-origin links for smooth client-side navigation.
  const onClick = (e) => {
    const a = e.target.closest('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname.startsWith('/api') || /\.\w+$/.test(url.pathname)) return;
    e.preventDefault();
    navigate(url.pathname + url.hash);
  };

  const Page = route?.Page;
  const link = (to, label) => (
    <a href={to} aria-current={path === to ? 'page' : undefined}>
      {label}
    </a>
  );

  return (
    <div onClick={onClick}>
      <a href="#main" className="sr-only">Skip to content</a>
      <header className={`nav${scrolled ? ' scrolled' : ''}`}>
        <div className="wrap nav-inner">
          <a href="/" className="brand" aria-label="ContextPort home">
            <img src="/favicon.svg" alt="" width="28" height="28" />
            ContextPort
          </a>
          <nav className="nav-links" aria-label="Main">
            {link('/#how', 'How it works')}
            {link('/#privacy', 'Privacy')}
            {link('/help', 'Help')}
          </nav>
          <div className="nav-cta">
            <a className="btn primary small" href="/install">Get it free</a>
          </div>
          <button className="menu-btn" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name={menu ? 'close' : 'menu'} />
          </button>
        </div>
        <div className={`mobile-menu${menu ? ' open' : ''}`}>
          {link('/#how', 'How it works')}
          {link('/#privacy', 'Privacy')}
          {link('/help', 'Help')}
          <a className="btn primary" href="/install">Get it free</a>
        </div>
      </header>

      <main id="main">
        {Page ? (
          <Page />
        ) : (
          <section className="wrap notfound">
            <p className="eyebrow">404</p>
            <h1 className="display d-xl">This page moved on</h1>
            <p className="lead">Let's get you back to somewhere useful.</p>
            <a className="btn primary" href="/" style={{ marginTop: 24 }}>Go home</a>
          </section>
        )}
      </main>

      <footer className="footer">
        <div className="wrap">
          <div className="footer-grid">
            <div>
              <a href="/" className="brand">
                <img src="/favicon.svg" alt="" width="28" height="28" />
                ContextPort
              </a>
              <p className="muted" style={{ maxWidth: 320, marginTop: 12, fontSize: 15 }}>
                Continue any AI conversation somewhere else — without starting over.
              </p>
            </div>
            <div>
              <h4>Product</h4>
              <ul>
                <li><a href="/#how">How it works</a></li>
                <li><a href="/#engines">AI engines</a></li>
                <li><a href="/install">Install</a></li>
              </ul>
            </div>
            <div>
              <h4>Support</h4>
              <ul>
                <li><a href="/help">Help & FAQ</a></li>
                <li><a href="/help#troubleshooting">Troubleshooting</a></li>
              </ul>
            </div>
            <div>
              <h4>Legal</h4>
              <ul>
                <li><a href="/privacy">Privacy</a></li>
                <li><a href="/terms">Terms</a></li>
              </ul>
            </div>
          </div>
          <div className="fine">
            <span>© {new Date().getFullYear()} ContextPort</span>
            <span>Not affiliated with OpenAI, Anthropic, Google or Perplexity.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
