import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import './styles.css';
import App from './App.jsx';

/**
 * Vercel Web Analytics (cookieless page views). Share links keep their
 * decryption key in the URL #fragment and /admin is private, so those pages
 * are never reported; everywhere else only origin + path is sent.
 */
function privacySafe(event) {
  const url = new URL(event.url);
  if (/^\/(s|admin)(\/|$)/.test(url.pathname)) return null;
  url.hash = '';
  url.search = '';
  return { ...event, url: url.toString() };
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <Analytics beforeSend={privacySafe} />
  </StrictMode>,
);
