// Lines that keep off the nodes they do not join (Canvas.tsx): whether a drawn line passes through a node, and, when
// it does, the shortest way between the two ends that goes round every node in between — from corner to corner of
// the nodes, a little way off each — drawn with its corners rounded.

export interface Pt { x: number; y: number }
export interface Box { id: string; x: number; y: number; w: number; h: number }

const len = (p: Pt, q: Pt) => Math.hypot(q.x - p.x, q.y - p.y);
const inside = (p: Pt, b: Box, m: number) => p.x > b.x - m && p.x < b.x + b.w + m && p.y > b.y - m && p.y < b.y + b.h + m;

// does the stretch from p to q pass through the box grown by m (touching its edge does not count)
function cuts(p: Pt, q: Pt, b: Box, m: number): boolean {
  const x0 = b.x - m, x1 = b.x + b.w + m, y0 = b.y - m, y1 = b.y + b.h + m;
  if (Math.max(p.x, q.x) <= x0 || Math.min(p.x, q.x) >= x1 || Math.max(p.y, q.y) <= y0 || Math.min(p.y, q.y) >= y1) return false;
  let t0 = 0, t1 = 1;
  for (const [d, lo, hi] of [[q.x - p.x, x0 - p.x, x1 - p.x], [q.y - p.y, y0 - p.y, y1 - p.y]]) {
    if (!d) continue; // along this axis it stays between the two sides (the test above)
    const a = Math.min(lo / d, hi / d), z = Math.max(lo / d, hi / d);
    t0 = Math.max(t0, a); t1 = Math.min(t1, z);
    if (t0 >= t1) return false;
  }
  return true;
}

export const crosses = (pts: Pt[], boxes: Box[], m: number) => pts.some((p, i) => i > 0 && boxes.some(b => cuts(pts[i - 1], p, b, m)));

// the shortest way from one point to another that stays `pad` clear of the boxes; null when there is none
export function around(from: Pt, to: Pt, boxes: Box[], pad = 14): Pt[] | null {
  // only what stands near the way; a box one of the ends lies in cannot be gone round
  const x0 = Math.min(from.x, to.x) - 320, x1 = Math.max(from.x, to.x) + 320, y0 = Math.min(from.y, to.y) - 320, y1 = Math.max(from.y, to.y) + 320;
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const near = boxes.filter(b => b.x + b.w > x0 && b.x < x1 && b.y + b.h > y0 && b.y < y1 && !inside(from, b, pad) && !inside(to, b, pad))
    .sort((a, b) => len(mid, { x: a.x + a.w / 2, y: a.y + a.h / 2 }) - len(mid, { x: b.x + b.w / 2, y: b.y + b.h / 2 })).slice(0, 60);
  const free = (p: Pt, q: Pt) => !near.some(b => cuts(p, q, b, pad));
  if (free(from, to)) return [from, to];
  const g = pad + 1;
  const pts: Pt[] = [from, to, ...near.flatMap(b => [{ x: b.x - g, y: b.y - g }, { x: b.x + b.w + g, y: b.y - g }, { x: b.x + b.w + g, y: b.y + b.h + g }, { x: b.x - g, y: b.y + b.h + g }])
    .filter(p => !near.some(b => inside(p, b, pad)))];
  const n = pts.length, dist = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
  dist[0] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] + len(pts[i], to) < best) { best = dist[i] + len(pts[i], to); u = i; }
    if (u < 0) return null;
    if (u === 1) break;
    done[u] = true;
    for (let i = 1; i < n; i++) {
      if (done[i]) continue;
      const d = dist[u] + len(pts[u], pts[i]) + 10; // a little for every corner: of two ways about as long, the straighter
      if (d < dist[i] && free(pts[u], pts[i])) { dist[i] = d; prev[i] = u; }
    }
  }
  const way: Pt[] = [];
  for (let i = 1; i >= 0; i = prev[i]) way.unshift(pts[i]);
  return way;
}

// the points as one line, its corners rounded
export function rounded(pts: Pt[], r = 18): string {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], c = pts[i], b = pts[i + 1], la = len(a, c) || 1, lb = len(c, b) || 1, k = Math.min(r, la / 2, lb / 2);
    d += ` L${c.x + ((a.x - c.x) * k) / la},${c.y + ((a.y - c.y) * k) / la} Q${c.x},${c.y} ${c.x + ((b.x - c.x) * k) / lb},${c.y + ((b.y - c.y) * k) / lb}`;
  }
  const z = pts[pts.length - 1];
  return `${d} L${z.x},${z.y}`;
}

// the point half-way along
export function halfway(pts: Pt[]): Pt {
  let rest = pts.slice(1).reduce((s, p, i) => s + len(pts[i], p), 0) / 2;
  for (let i = 1; i < pts.length; i++) {
    const l = len(pts[i - 1], pts[i]);
    if (rest <= l) { const t = l ? rest / l : 0; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; }
    rest -= l;
  }
  return pts[pts.length - 1];
}
