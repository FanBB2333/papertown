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

handDrawn(true);
const style = document.createElement('style');
style.textContent = themeCSS(THEMES.sketch);
document.head.appendChild(style);
paperAndPencil((THEMES.sketch as { ui: { brand: string } }).ui.brand);

function localizeArt() {
  if (LANG === 'en') for (const v of [...Object.values(DISTRICTS), ...Object.values(BUILDINGS)]) if (v.en) v.name = v.en;
  for (const t of [DISTRICTS, BUILDINGS, ITEMS, PROPS, WORKERS, FLOW_KINDS]) localize(t);
}

// app modules compute tr() strings at load, so they are imported only after loadLang()
loadLang().then(() => { localizeArt(); return import('./Root'); })
  .then(({ Root }) => createRoot(document.getElementById('root')!).render(<Root />));
