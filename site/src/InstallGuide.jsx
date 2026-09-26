import { useState } from 'react';
import { Icon } from './ui.jsx';

const BROWSERS = [
  ['Chrome', 'chrome://extensions'],
  ['Edge', 'edge://extensions'],
  ['Brave', 'brave://extensions'],
  ['Arc / Opera / others', 'chrome://extensions'],
];

/** Browsers block links to chrome:// pages, so we offer to copy the address instead. */
function CopyAddress() {
  const [browser, setBrowser] = useState(0);
  const [copied, setCopied] = useState(false);
  const address = BROWSERS[browser][1];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="addr">
      <div className="addr-tabs" role="tablist" aria-label="Your browser">
        {BROWSERS.map(([name], i) => (
          <button key={name} role="tab" aria-selected={i === browser} onClick={() => setBrowser(i)}>
            {name}
          </button>
        ))}
      </div>
      <div className="addr-row">
        <code>{address}</code>
        <button className="btn small" onClick={copy}>
          <Icon name={copied ? 'check' : 'code'} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="addr-hint">Paste it into the address bar and press Enter.</p>
    </div>
  );
}

export function DownloadButton({ label = 'Download the extension' }) {
  return (
    <a className="btn primary" href="/api/v1/download" download="contextport-extension.zip">
      <Icon name="download" />
      {label}
    </a>
  );
}

/** The four install steps, shared by the home page and /install. */
export default function InstallGuide() {
  return (
    <ol className="install-steps">
      <li>
        <div>
          <strong>Download and unzip</strong>
          <p>
            Download <code>contextport-extension.zip</code>, then unzip it: double-click it on a Mac, or right-click → <em>Extract All</em> on
            Windows. Keep the folder somewhere permanent, like Documents — Chrome runs the extension from it.
          </p>
          <DownloadButton label="Download the .zip" />
        </div>
      </li>
      <li>
        <div>
          <strong>Open your browser’s extensions page</strong>
          <CopyAddress />
        </div>
      </li>
      <li>
        <div>
          <strong>Turn on Developer mode, then click “Load unpacked”</strong>
          <p>
            The Developer mode switch is at the top-right of the extensions page. Then click <em>Load unpacked</em> and choose the unzipped
            folder — the one that contains <code>manifest.json</code>.
          </p>
        </div>
      </li>
      <li>
        <div>
          <strong>Pin it and open a chat</strong>
          <p>
            Click the puzzle-piece icon in the toolbar and pin ContextPort. Then open (or reload) ChatGPT, Claude or Gemini — the
            <em> Transfer</em> button appears at the bottom-right.
          </p>
        </div>
      </li>
    </ol>
  );
}

export const INSTALL_FAQ = [
  [
    '“Manifest file is missing or unreadable”',
    'You picked the wrong folder. Choose the folder that directly contains manifest.json — sometimes unzipping creates a folder inside a folder.',
  ],
  [
    'Chrome shows “Disable developer mode extensions”',
    'Chrome shows this for every extension installed outside the Chrome Web Store. Close the message (don’t click Disable) — ContextPort keeps working.',
  ],
  [
    'I don’t see the Transfer button',
    'Reload the ChatGPT, Claude or Gemini tab once after installing. You can also use the toolbar icon or press Alt+Shift+T.',
  ],
  [
    'How do I update?',
    'Download the new zip, replace the files in your ContextPort folder, then click the ↻ reload icon on the ContextPort card at chrome://extensions and reload your chat tabs. Your history and settings stay.',
  ],
  ['I moved or deleted the folder', 'Chrome needs the folder to run the extension. Unzip it again somewhere permanent and click Load unpacked once more.'],
];
