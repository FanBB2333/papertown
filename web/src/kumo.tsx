// Cloudflare's component library (Kumo) in this page. Its stylesheet only reaches inside .kumo-ui
// (see vite.config.ts), so what it draws sits in a layer of its own beside the app: the settings
// page and every list, menu and popover its components open. The app under it is one stacking
// context (isolation in cloudflare.css), so the layer is over all of it.

import { KumoPortalProvider } from '@cloudflare/kumo';
import '@cloudflare/kumo/styles/standalone';
import './cloudflare.css';

export const layer = document.createElement('div');
layer.className = 'kumo-ui kumo-layer';
document.body.append(layer);

export function Kumo({ children }: { children: React.ReactNode }) {
  return <KumoPortalProvider container={layer}>{children}</KumoPortalProvider>;
}
