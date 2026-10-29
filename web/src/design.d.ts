// Types for the shared design modules (plain JS in design/src).

declare module '@design/theme.js' {
  export const THEMES: Record<string, unknown>;
  export function themeCSS(theme: unknown): string;
}

declare module '@design/sprites.js' {
  export const DISTRICTS: Record<string, { name: string; en: string; dir: string; color: string }>;
  export const BUILDINGS: Record<string, { name: string; rep: string; tech: string; district: string; accent: string; w: number; d: number; h: number; later?: boolean }>;
  export function iso(x: number, y: number, z?: number): [number, number];
  export function handDrawn(on?: boolean): void;
  export const ITEMS: Record<string, { name: string }>;
  export const WORKERS: Record<string, { name: string }>;
  export function spriteSVG(type: string, o?: { label?: string | null; accent?: string | null }): { html: string };
  export function itemSVG(key: string): string;
  export function workerSVG(key: string): string;
}

declare module '@design/world.js' {
  export const FLOW_KINDS: Record<string, string>;
  export function renderMap(o?: Record<string, unknown>): string;
  export function footprint(p: { type: string; x: number; y: number }): { x: number; y: number; w: number; d: number };
  export function tileMat(x: number, y: number): string;
}

declare module '@design/layouts.js' {
  export const LOGO: string;
}

declare module '@design/style.css';
