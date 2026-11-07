import { createRoot } from 'react-dom/client';
import { BUILDINGS, DISTRICTS, ITEMS, PROPS, WORKERS, handDrawn } from '@design/sprites.js';
import { THEMES, themeCSS } from '@design/theme.js';
import { FLOW_KINDS } from '@design/world.js';
import '@design/style.css';
import './app.css';
import './rooms.css';
import './hand.css';
import { paperAndPencil } from './hand';
import { LANG, loadLang, localize } from './i18n';

// the ink-and-wash palette as CSS variables (same source as the design pages), sprites
// drawn by hand, and the paper textures the stylesheet layers on top
handDrawn(true);
const style = document.createElement('style');
style.textContent = themeCSS(THEMES.sketch);
document.head.appendChild(style);
paperAndPencil((THEMES.sketch as { ui: { brand: string } }).ui.brand);

// the shared art's names in the language in use: in English the art's own English names where
// it has them, the dictionary for the rest
function localizeArt() {
  if (LANG === 'en') for (const v of [...Object.values(DISTRICTS), ...Object.values(BUILDINGS)]) if (v.en) v.name = v.en;
  for (const t of [DISTRICTS, BUILDINGS, ITEMS, PROPS, WORKERS, FLOW_KINDS]) localize(t);
}

// the app's modules work some of their strings out as they load, so they load once the language is ready
loadLang().then(() => { localizeArt(); return import('./Root'); })
  .then(({ Root }) => createRoot(document.getElementById('root')!).render(<Root />));
