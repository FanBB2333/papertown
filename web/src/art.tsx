// Small wrappers around the shared SVG sprites.

import { useId } from 'react';
import { BUILDINGS, ITEMS, WORKERS, itemSVG, spriteSVG, workerSVG } from '@design/sprites.js';
import { tr } from './i18n';

const html = (__html: string) => ({ dangerouslySetInnerHTML: { __html } });

export const ROLE_NAMES: Record<string, string> = {
  hatcher: tr('孵化员'), scout: tr('调研员'), designer: tr('方法设计师'), experimenter: tr('实验员'), writer: tr('写手'), reviewer: tr('审稿人'), keeper: tr('仓管员'),
};

// Papertown's mark: a sheet of paper whose top edge is cut into the town's roofs, with the mill's
// chimney smoking at the end and the sheet's corner folded over (also web/public/logo.svg)
const SHEET = 'M8 56V32l11.5-12.5L29 29l10-11 7 7V11h6v34L41 56Z';
export function Logo() {
  const clip = `pt-${useId().replace(/:/g, '')}`;
  return (
    <svg className="logo-ic" viewBox="2 0 60 60" aria-hidden="true">
      <defs><clipPath id={clip}><path d={SHEET} /></clipPath></defs>
      <path className="logo-smoke" d="M49 7c-1.4-2.4.9-4.6 3.3-3.8 1.3-2.4 4.7-2.4 5.9-.2" fill="none" stroke="#b3a184" strokeWidth="2.3" strokeLinecap="round" />
      <g clipPath={`url(#${clip})`}>
        <rect width="64" height="64" fill="#fcf8f0" />
        <rect width="64" height="32" fill="#c2663f" />
        <rect x="46" width="6" height="32" fill="#9e4f2f" />
      </g>
      <circle cx="39" cy="25.5" r="2.4" fill="#f6dc9c" stroke="#2f261d" strokeWidth="1.6" />
      <path d="M8 32h38" stroke="#2f261d" strokeWidth="2" strokeLinecap="round" />
      <path d="M15 40h19M15 45.5h23M15 51h12" stroke="#c2b39a" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M52 45h-8a3 3 0 0 0-3 3v8" fill="#eadcc3" stroke="#2f261d" strokeWidth="2.2" strokeLinejoin="round" />
      <path d={SHEET} fill="none" stroke="#2f261d" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

export function Sprite({ type, label, accent }: { type: string; label?: string | null; accent?: string | null }) {
  if (!BUILDINGS[type]) return null;
  return <span style={{ display: 'contents' }} {...html(spriteSVG(type, { label, accent }).html)} />;
}

export function Item({ k }: { k: string }) {
  if (!ITEMS[k]) return null;
  return <span style={{ display: 'contents' }} {...html(itemSVG(k))} />;
}

export function Ava({ role, level, code }: { role: string; level?: number; code?: string }) {
  if (!WORKERS[role]) return null;
  const title = `${ROLE_NAMES[role] ?? role}${code ? ' ' + code : ''}${level ? ' Lv.' + level : ''}`;
  return <span className="ava" title={title} {...html(workerSVG(role))} />;
}

export const itemName = (k: string) => ITEMS[k]?.name ?? k;
