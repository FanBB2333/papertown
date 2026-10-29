import { createRoot } from 'react-dom/client';
import 'lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css';
import { handDrawn } from '@design/sprites.js';
import { THEMES, themeCSS } from '@design/theme.js';
import '@design/style.css';
import './app.css';
import './rooms.css';
import './hand.css';
import { App } from './App';
import { paperAndPencil } from './hand';

// the ink-and-wash palette as CSS variables (same source as the design pages), sprites
// drawn by hand, and the paper textures the stylesheet layers on top
handDrawn(true);
const style = document.createElement('style');
style.textContent = themeCSS(THEMES.sketch);
document.head.appendChild(style);
paperAndPencil((THEMES.sketch as { ui: { brand: string } }).ui.brand);

createRoot(document.getElementById('root')!).render(<App />);
