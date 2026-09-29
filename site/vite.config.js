import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The share page reuses the extension's formatter from ../shared.
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        configure: (proxy) => {
          proxy.on('error', (err, req, res) => {
            if (req.url?.startsWith('/api/v1/download')) {
              res.writeHead(302, { Location: '/contextport-extension.zip' });
              res.end();
            }
          });
        },
      },
    },
    fs: { allow: ['..'] },
  },
  build: { sourcemap: false, assetsInlineLimit: 0 },
});
