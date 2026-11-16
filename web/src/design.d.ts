// Types for the shared design modules (plain JS in design/src).

declare module '@design/theme.js' {
  export const THEMES: Record<string, unknown>;
  export function themeCSS(theme: unknown): string;
  export function matColor(theme: unknown, mat: string, accent: string): string;
}

declare module '@design/sprites.js' {
  export const DISTRICTS: Record<string, { name: string; en: string; dir: string; color: string }>;
  export const BUILDINGS: Record<string, { name: string; en?: string; rep: string; tech: string; district: string; accent: string; w: number; d: number; h: number; later?: boolean;
    draw(p: Pen, o?: Record<string, unknown>): void }>;
  export const PROPS: Record<string, { name: string; w: number; d: number; draw(p: Pen): void }>;
  export function iso(x: number, y: number, z?: number): [number, number];
  export const ZU: number;
  // Pen3 in town3d re-implements these drawing calls in 3D
  export class Pen {
    constructor(k?: number);
    k: number;
    o: string[];
    I(x: number, y: number, z?: number): [number, number];
    P(x: number, y: number, z?: number): [number, number];
    grow(x: number, y: number): void;
    poly(pts: number[][], cls: string): this;
    line(pts: number[][], cls: string): this;
    path(d: string, cls: string, box?: number[][]): this;
    ell(cx: number, cy: number, rx: number, ry: number, cls: string): this;
    circ(cx: number, cy: number, r: number, cls: string): this;
    box(x: number, y: number, z: number, w: number, d: number, h: number, m: string): this;
    gableX(x: number, y: number, z: number, w: number, d: number, rh: number, m: string, me?: string): this;
    gableY(x: number, y: number, z: number, w: number, d: number, rh: number, m: string, me?: string): this;
    pyramid(x: number, y: number, z: number, w: number, d: number, rh: number, m: string): this;
    sawtooth(x: number, y: number, z: number, w: number, d: number, n: number, th: number, m: string, mg: string): this;
    cyl(cx: number, cy: number, z: number, r: number, h: number, m: string, cap?: boolean): this;
    dome(cx: number, cy: number, z: number, r: number, hd: number, m: string): this;
    egg(cx: number, cy: number, z: number, r: number, h: number, m: string): this;
    cooling(cx: number, cy: number, z: number, r: number, h: number, m: string): this;
    winL(Y: number, x0: number, z0: number, w: number, h: number, m?: string): this;
    winR(X: number, y0: number, z0: number, w: number, h: number, m?: string): this;
    textL(x: number, Y: number, z: number, s: string, size?: number, cls?: string): this;
    textR(X: number, y: number, z: number, s: string, size?: number, cls?: string): this;
    decalL(x: number, Y: number, z: number, inner: string): this;
    decalR(X: number, y: number, z: number, inner: string): this;
    smoke(cx: number, cy: number, z: number, s?: number): this;
    figure(x: number, y: number, m: string): this;
  }
  export function handDrawn(on?: boolean): void;
  export const ITEMS: Record<string, { name: string }>;
  export const WORKERS: Record<string, { name: string; rep: string; accent: string; mark: string }>;
  export function spriteSVG(type: string, o?: { label?: string | null; accent?: string | null }): { html: string };
  export function itemSVG(key: string): string;
  export function workerSVG(key: string): string;
}

declare module '@design/world.js' {
  export const FLOW_KINDS: Record<string, string>;
  export function renderMap(o?: Record<string, unknown>): string;
  export function footprint(p: { type: string; x: number; y: number }): { x: number; y: number; w: number; d: number };
  export function tileMat(x: number, y: number): string;
  export function scaleOf(p: { type: string }): number;
  export const N: number;
  export const RING: number[];
  export const KEY_LABELS: Set<string>;
  export function placementName(p: { type: string; name?: string | null }): string;
  export function yards(places: { id: string; type: string; x: number; y: number; accent?: string | null }[]): { id: string; pts: [number, number][]; accent: string }[];
  export function decorItems(places: { id: string; type: string; x: number; y: number }[], decor?: 'full' | 'light' | 'none'): { k: number; prop: string; x: number; y: number }[];
}

declare module '@design/style.css';
