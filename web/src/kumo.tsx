// Kumo (Cloudflare's components). Its CSS is scoped under .kumo-ui by vite.config.ts, so its portals
// render into a .kumo-ui layer; the app is one stacking context (cloudflare.css), so the layer sits above it.

import { KumoPortalProvider } from '@cloudflare/kumo';
import '@cloudflare/kumo/styles/standalone';
import './cloudflare.css';
import './macos.css';

export const layer = document.createElement('div');
layer.className = 'kumo-ui kumo-layer';
document.body.append(layer);

export function Kumo({ children }: { children: React.ReactNode }) {
  return <KumoPortalProvider container={layer}>{children}</KumoPortalProvider>;
}
