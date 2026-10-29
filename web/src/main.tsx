import { createRoot } from 'react-dom/client';
import { THEMES, themeCSS } from '@design/theme.js';
import '@design/style.css';
import './app.css';
import './rooms.css';
import { App } from './App';

// the paper-craft palette as CSS variables (same source as the design pages)
const style = document.createElement('style');
style.textContent = themeCSS(THEMES.paper);
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
