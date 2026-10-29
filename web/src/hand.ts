// Paper and pencil for the hand-drawn look, made once at start and handed to CSS as
// custom properties: a paper grain, a soft watercolour bloom, and a few hand-drawn box
// outlines that panels and buttons stretch over themselves as a background image.

const INK = 'rgba(46,31,18,.5)';

function rng(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function canvas(size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, g: c.getContext('2d')! };
}

// mostly white with sparse darker specks and a few fibres
function grain(size = 240): string {
  const { c, g } = canvas(size);
  const img = g.createImageData(size, size), r = rng(7);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 255 - Math.floor(r() * r() * r() * 60);
    img.data[i] = v; img.data[i + 1] = v - 1; img.data[i + 2] = v - 4; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.lineWidth = 0.6;
  for (let k = 0; k < 46; k++) {
    const x = r() * size, y = r() * size, a = r() * Math.PI, l = 5 + r() * 16;
    g.strokeStyle = `rgba(120,90,60,${0.04 + r() * 0.05})`;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * l / 2 + (r() - 0.5) * 5, y + Math.sin(a) * l / 2 + (r() - 0.5) * 5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  return c.toDataURL('image/png');
}

// tileable value noise in three octaves: the uneven pooling of a watercolour wash
function bloom(size = 384): string {
  const { c, g } = canvas(size);
  const img = g.createImageData(size, size), r = rng(11);
  const oct = ([[5, 0.6], [11, 0.28], [23, 0.12]] as const).map(([n, w]) => ({ n, w, grid: Array.from({ length: n * n }, r) }));
  const s = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const o of oct) {
        const fx = x / size * o.n, fy = y / size * o.n, ix = Math.floor(fx), iy = Math.floor(fy), tx = s(fx - ix), ty = s(fy - iy);
        const at = (i: number, j: number) => o.grid[(j % o.n) * o.n + (i % o.n)];
        v += o.w * ((at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty);
      }
      // warm, faint pooling: never grey, at most a light tea stain
      const k = (y * size + x) * 4, d = Math.max(0, v - 0.42) * 30;
      img.data[k] = 255 - d * 0.6; img.data[k + 1] = 255 - d * 0.9; img.data[k + 2] = 255 - d * 1.6; img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

const f = (n: number) => n.toFixed(2);

// a box drawn by hand twice in a 100×100 field, stretched over the element
function box(seed: number, color = INK, width = 1.2): string {
  const r = rng(seed), j = (a: number) => (r() - 0.5) * a;
  const c = [[1.3, 1.5], [98.7, 1.2], [98.8, 98.6], [1.2, 98.8]].map(([x, y]) => [x + j(0.7), y + j(0.7)]);
  const paths: string[] = [];
  for (const [pass, over, op] of [[0, 0.4, 1], [1, 0.18, 0.32]] as const) {
    let d = '';
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4], ux = b[0] - a[0], uy = b[1] - a[1], len = Math.hypot(ux, uy);
      const A = [a[0] - ux / len * over + j(0.5), a[1] - uy / len * over + j(0.5)];
      const B = [b[0] + ux / len * over + j(0.5), b[1] + uy / len * over + j(0.5)];
      const m = [(A[0] + B[0]) / 2 + j(0.7), (A[1] + B[1]) / 2 + j(0.7)];
      d += `M${f(A[0])},${f(A[1])}Q${f(m[0])},${f(m[1])} ${f(B[0])},${f(B[1])}`;
    }
    paths.push(`<path d="${d}" fill="none" stroke="${color}" stroke-opacity="${op}" stroke-width="${pass ? width * 0.8 : width}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">${paths.join('')}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// a circle drawn in one go that does not quite close, for round buttons
function ring(seed: number, color = INK): string {
  const r = rng(seed);
  let d = '';
  const n = 28, start = r() * Math.PI * 2, sweep = Math.PI * 2 * 1.06;
  for (let i = 0; i <= n; i++) {
    const a = start + sweep * i / n, rad = 46.5 + Math.sin(a * 2 + seed) * 0.9 + (r() - 0.5) * 0.6;
    d += `${i ? 'L' : 'M'}${f(50 + Math.cos(a) * rad)},${f(50 + Math.sin(a) * rad)}`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// a single hand-drawn rule, for underlines and dividers
function rule(seed: number, color = INK): string {
  const r = rng(seed), j = (a: number) => (r() - 0.5) * a;
  const d = `M0.5,${f(5 + j(1.5))}Q25,${f(5 + j(3))} 50,${f(5 + j(2))}T99.5,${f(5 + j(1.5))}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 10" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function paperAndPencil(brand: string) {
  const root = document.documentElement.style;
  root.setProperty('--grain', `url(${grain()})`);
  root.setProperty('--bloom', `url(${bloom()})`);
  root.setProperty('--box-a', box(3));
  root.setProperty('--box-b', box(17));
  root.setProperty('--box-c', box(29));
  root.setProperty('--box-brand', box(41, brand, 1.5));
  root.setProperty('--ring', ring(13));
  root.setProperty('--rule', rule(5));
  root.setProperty('--rule-brand', rule(9, brand));
}
