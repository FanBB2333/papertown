import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The map renderer, sprites and paper-craft styles live in design/src and are shared
// with the design pages, so the app imports them through the @design alias.
const design = fileURLToPath(new URL('../design/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@design': design } },
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
  },
});
