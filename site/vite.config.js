import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The share page reuses the extension's formatter from ../shared.
  server: { proxy: { '/api': 'http://localhost:8787' }, fs: { allow: ['..'] } },
  build: { sourcemap: false, assetsInlineLimit: 0 },
});
