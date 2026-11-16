// The refracting edge of Liquid Glass: an SVG displacement map per piece of glass. backdrop-filter takes
// an SVG filter only in Chromium; Safari/WebKit (incl. the macOS app) and Firefox keep the plain blur.

import { useEffect, useRef } from 'react';
import { useSettings } from './settings';

const SVG = 'http://www.w3.org/2000/svg';
const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
export const bends = !!brands?.some(b => b.brand === 'Chromium');
const plain = matchMedia('(prefers-reduced-transparency: reduce)');

const KEEP = 48;
const made = new Map<string, SVGFilterElement>();
let defs: SVGSVGElement | null = null;

// one pixel per CSS pixel; red/green carry the inward pull around 128, fading out over `bezel`
function map(w: number, h: number, r: number, bezel: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!, img = g.createImageData(w, h), d = img.data;
  const hw = w / 2, hh = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + .5 - hw, py = y + .5 - hh;
      const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const inside = -(Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - r);
      const i = (y * w + x) * 4;
      let dx = 0, dy = 0;
      if (inside >= 0 && inside < bezel) {
        const t = 1 - inside / bezel, pull = t * t * (3 - 2 * t);
        let nx = ox, ny = oy;
        if (!nx && !ny) { if (qx > qy) nx = 1; else ny = 1; }
        const n = Math.hypot(nx, ny);
        dx = -Math.sign(px) * (nx / n) * pull;
        dy = -Math.sign(py) * (ny / n) * pull;
      }
      d[i] = 128 + dx * 127;
      d[i + 1] = 128 + dy * 127;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function filterFor(w: number, h: number, r: number, bezel: number, strength: number) {
  const id = `lens-${w}-${h}-${r}-${bezel}-${strength}`;
  if (made.has(id)) return id;
  if (!defs) {
    defs = document.createElementNS(SVG, 'svg');
    defs.setAttribute('aria-hidden', 'true');
    defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    document.body.append(defs);
  }
  const f = document.createElementNS(SVG, 'filter');
  f.id = id;
  for (const [k, v] of [['x', '0'], ['y', '0'], ['width', `${w}`], ['height', `${h}`], ['filterUnits', 'userSpaceOnUse'], ['primitiveUnits', 'userSpaceOnUse'], ['color-interpolation-filters', 'sRGB']]) f.setAttribute(k, v);
  const image = document.createElementNS(SVG, 'feImage');
  image.setAttribute('href', map(w, h, r, bezel));
  for (const [k, v] of [['x', '0'], ['y', '0'], ['width', `${w}`], ['height', `${h}`], ['preserveAspectRatio', 'none'], ['result', 'map']]) image.setAttribute(k, v);
  const bend = document.createElementNS(SVG, 'feDisplacementMap');
  for (const [k, v] of [['in', 'SourceGraphic'], ['in2', 'map'], ['scale', `${strength}`], ['xChannelSelector', 'R'], ['yChannelSelector', 'G']]) bend.setAttribute(k, v);
  f.append(image, bend);
  defs.append(f);
  made.set(id, f);
  if (made.size > KEEP) {
    const [old, el] = made.entries().next().value!;
    el.remove();
    made.delete(old);
  }
  return id;
}

// Put the ref on a piece of glass whose rule has `backdrop-filter: var(--lens,) blur(…)`; while it
// resizes it falls back to the blur.
export function useLens<T extends HTMLElement>(bezel = 16, strength = 44) {
  const ref = useRef<T>(null);
  const on = useSettings().ui === 'macos' && bends && !plain.matches;
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const place = () => {
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (w < 8 || h < 8) return;
      const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2);
      el.style.setProperty('--lens', `url(#${filterFor(w, h, Math.round(r), Math.min(bezel, w / 2, h / 2), strength)})`);
    };
    let wait = 0;
    const watch = new ResizeObserver(() => {
      el.style.removeProperty('--lens');
      clearTimeout(wait);
      wait = window.setTimeout(place, 160);
    });
    watch.observe(el);
    place();
    return () => { clearTimeout(wait); watch.disconnect(); el.style.removeProperty('--lens'); };
  }, [on, bezel, strength]);
  return ref;
}
