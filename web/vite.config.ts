import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// design/src (map renderer, sprites, paper styles) is shared with the design pages.
const design = fileURLToPath(new URL('../design/src', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

// [server] port in a papertown.toml; `commented`: the default papertown.example.toml lists as `# port = N`
function tomlPort(file: string, commented = false): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = commented ? /^\s*#\s*port\s*=\s*(\d+)/ : /^\s*port\s*=\s*(\d+)/;
  let server = false;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    const head = l.match(/^\s*\[\s*([^\]\s]+)\s*\]/);
    if (head) server = head[1] === 'server';
    const m = server && l.match(line);
    if (m) return m[1];
  }
  return undefined;
}

// the server's port as `papertown serve` reads it (server/papertown/config.py): PAPERTOWN_PORT, else
// [server] port in $PAPERTOWN_CONFIG or papertown.toml, else the default, which config.py defines
function serverPort(): string {
  const conf = process.env.PAPERTOWN_CONFIG?.trim().replace(/^~(?=\/|$)/, homedir());
  const port = process.env.PAPERTOWN_PORT?.trim() || tomlPort(resolve(conf || join(root, 'papertown.toml')))
    || tomlPort(join(root, 'papertown.example.toml'), true);
  if (!port) throw new Error('no server port: set PAPERTOWN_PORT or [server] port in papertown.toml');
  return port;
}

// Kumo's CSS resets every element, so it is scoped under :where(.kumo-ui) (no added specificity);
// its colour tokens stay on :root, where the page's own Cloudflare look reads them.
const OWN_TOKENS = /:root|:host|\[data-theme|\[data-mode/;

export default defineConfig(({ command }) => ({
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
    // only the dev server (and preview) proxies, so a build reads no config
    proxy: command === 'serve' ? { '/api': { target: `http://127.0.0.1:${serverPort()}`, changeOrigin: true } } : undefined,
  },
}));
