import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The map renderer, sprites and paper-craft styles live in design/src and are shared
// with the design pages, so the app imports them through the @design alias.
const design = fileURLToPath(new URL('../design/src', import.meta.url));

// Kumo's stylesheet resets every element and brings a few thousand utility classes, which is right
// for what Kumo draws and wrong for the rest of the page. So all of it goes under .kumo-ui, with no
// weight added: its colour tokens stay on :root, where the page's own Cloudflare look reads them.
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
            if (up?.type === 'rule' || up?.name?.endsWith('keyframes')) return; // nested in a scoped rule, or a keyframe
            if (rule.selector === 'html,:host') rule.selector = '.kumo-ui';
            else rule.selectors = rule.selectors.map(x => (OWN_TOKENS.test(x) ? x : `:where(.kumo-ui) ${x}`));
          });
        },
      }],
    },
  },
  // three.js and OpenCC's dictionaries, each in its own chunk, loaded only for the 3D town and
  // for Traditional Chinese
  build: { chunkSizeWarningLimit: 1100 },
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
  },
});
