// Small wrappers around the shared SVG sprites.

import { BUILDINGS, ITEMS, WORKERS, itemSVG, spriteSVG, workerSVG } from '@design/sprites.js';
import { LOGO } from '@design/layouts.js';
import { tr } from './i18n';

const html = (__html: string) => ({ dangerouslySetInnerHTML: { __html } });

export const ROLE_NAMES: Record<string, string> = {
  hatcher: tr('孵化员'), scout: tr('调研员'), designer: tr('方法设计师'), experimenter: tr('实验员'), writer: tr('写手'), reviewer: tr('审稿人'), keeper: tr('仓管员'),
};

export function Logo() {
  return <span style={{ display: 'contents' }} {...html(LOGO)} />;
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
