/**
 * Builds the extension into extension/dist (load that folder in chrome://extensions).
 *
 *   CONTEXTPORT_API=https://api.yourdomain.com node build.mjs
 *
 * The API origin is compiled in and added to host_permissions; nothing secret is bundled.
 */

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const out = path.join(here, process.env.CONTEXTPORT_TEST_BUILD === '1' ? 'dist-test' : 'dist');
const watch = process.argv.includes('--watch');

// On Vercel the zip points at the production domain automatically.
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
const API = (process.env.CONTEXTPORT_API || vercelUrl || 'http://localhost:8787').replace(/\/+$/, '');
const apiUrl = new URL(API);
if (apiUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(apiUrl.hostname)) {
  throw new Error('CONTEXTPORT_API must use https:// (except localhost for development)');
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: false,
  target: ['chrome116'],
  legalComments: 'none',
  define: { __API_BASE__: JSON.stringify(API), __TEST_BUILD__: JSON.stringify(process.env.CONTEXTPORT_TEST_BUILD === '1') },
  loader: { '.css': 'text' },
  logLevel: 'info',
};

const builds = [
  { entryPoints: [path.join(src, 'background/index.js')], outfile: path.join(out, 'background.js'), format: 'esm' },
  { entryPoints: [path.join(src, 'content/index.js')], outfile: path.join(out, 'content.js'), format: 'iife' },
  { entryPoints: [path.join(src, 'popup/popup.js')], outfile: path.join(out, 'popup/popup.js'), format: 'iife' },
  { entryPoints: [path.join(src, 'sidepanel/sidepanel.js')], outfile: path.join(out, 'sidepanel/sidepanel.js'), format: 'iife' },
  { entryPoints: [path.join(src, 'options/options.js')], outfile: path.join(out, 'options/options.js'), format: 'iife' },
];

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyStatic() {
  for (const page of ['popup', 'sidepanel', 'options']) {
    for (const f of fs.readdirSync(path.join(src, page))) {
      if (!f.endsWith('.js')) copy(path.join(src, page, f), path.join(out, page, f));
    }
  }
  copy(path.join(src, 'ui/base.css'), path.join(out, 'ui/base.css'));
  for (const f of fs.readdirSync(path.join(src, 'icons'))) copy(path.join(src, 'icons', f), path.join(out, 'icons', f));
  const fonts = {
    'newsreader-latin-300-normal.woff2': '@fontsource/newsreader/files/newsreader-latin-300-normal.woff2',
    'inter-latin-400-normal.woff2': '@fontsource/inter/files/inter-latin-400-normal.woff2',
    'inter-latin-500-normal.woff2': '@fontsource/inter/files/inter-latin-500-normal.woff2',
    'inter-latin-600-normal.woff2': '@fontsource/inter/files/inter-latin-600-normal.woff2',
  };
  for (const [name, rel] of Object.entries(fonts)) copy(path.join(here, 'node_modules', rel), path.join(out, 'fonts', name));

  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push(`${apiUrl.origin}/*`);
  // Network allowlist: the extension may only talk to our API and the AI providers.
  // Even a compromised dependency couldn't send a key anywhere else.
  const origins = [apiUrl.origin, ...manifest.optional_host_permissions.map((o) => o.replace(/\/\*$/, ''))];
  manifest.content_security_policy.extension_pages += `; connect-src 'self' ${origins.join(' ')}`;
  // Automated tests can't click Chrome's permission prompt, so the test build pre-grants provider origins.
  if (process.env.CONTEXTPORT_TEST_BUILD === '1') manifest.host_permissions.push(...manifest.optional_host_permissions);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

if (watch) {
  for (const b of builds) (await esbuild.context({ ...common, ...b })).watch();
  copyStatic();
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
  copyStatic();
  console.log(`Built extension -> ${out} (API: ${API})`);
}
