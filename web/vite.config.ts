import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// design/src (map renderer, sprites, paper styles) is shared with the design pages.
const design = fileURLToPath(new URL('../design/src', import.meta.url));

// Kumo's CSS resets every element, so it is scoped under :where(.kumo-ui) (no added specificity);
// its colour tokens stay on :root, where the page's own Cloudflare look reads them.
const OWN_TOKENS = /:root|:host|\[data-theme|\[data-mode/;

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@design': design } },
  css: {
    postcss: {
      plugins: [{
        postcssPlugin: 'kumo-scope',
        Once(root) {
          if (!root.source?.input.file?.includes('kumo-standalone')) return;
          root.walkRules(rule => {
            const up = rule.parent as { type?: string; name?: string } | undefined;
            if (up?.type === 'rule' || up?.name?.endsWith('keyframes')) return;
            if (rule.selector === 'html,:host') rule.selector = '.kumo-ui';
            else rule.selectors = rule.selectors.map(x => (OWN_TOKENS.test(x) ? x : `:where(.kumo-ui) ${x}`));
          });
        },
      }],
    },
  },
  // three.js and OpenCC's dictionaries are large lazy chunks
  build: { chunkSizeWarningLimit: 1100 },
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
  },
});
