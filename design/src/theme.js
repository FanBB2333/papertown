// Art styles. One palette definition feeds both the gallery (as CSS with color-mix)
// and the asset export (resolved to plain colors so the SVG files work anywhere).
//
// Material spec:
//   ['acc']            the sprite's accent colour
//   ['mix', p, base]   p% accent mixed with base
//   ['fixed', colour]
//   ['alpha', a]       accent at alpha a

export const THEMES = {
  paper: {
    key: 'paper', name: '纸艺', en: 'Paper-craft', tag: '推荐',
    pitch: '牛皮纸桌面上的纸模型小镇：暖色、细描边、错位投影，和 Papertown 这个名字最贴。',
    keywords: ['牛皮纸', '纸模型', '描边', '暖色'],
    pros: ['名字、世界观、画风一致，答辩时一句话讲得清', '暖色在投影机上不刺眼，文字对比度够', '描边让小尺寸建筑也能分辨'],
    cons: ['风格偏温和，"科技感"弱一些', '纸纹理和投影要克制，否则显脏'],
    ui: {
      bg: '#efe3cc', panel: '#fbf5e8', panel2: '#f2e7d0', ink: '#3b2a1a', muted: '#8a7458', line: '#d8c6a4',
      brand: '#b5603c', brandInk: '#fffaf0', ok: '#5f8f4e', warn: '#c48a2c', bad: '#b5523b',
      font: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif',
      head: '"Songti SC","STSong","Noto Serif SC",Georgia,serif',
      radius: '10px', border: '1px solid #d8c6a4', shadow: '3px 3px 0 rgba(110,80,40,.14)', headCase: 'none',
    },
    stroke: ['fixed', 'rgba(74,48,24,.55)'], strokeW: 0.8, shade: [22, 18],
    text: '#3b2a1a', smoke: '#fffaf0', hl: 'rgba(255,255,255,.42)', beam: 'rgba(255,236,170,.5)',
    mats: {
      wall: ['mix', 16, '#f3e8d2'], roof: ['mix', 88, '#5a3d26'], acc: ['acc'], acc2: ['fixed', '#c4553f'],
      base: ['fixed', '#dccaa6'], win: ['fixed', '#6b5640'], glass: ['mix', 18, '#d5e6e3'], metal: ['fixed', '#a39d90'],
      wood: ['fixed', '#bf9566'], white: ['fixed', '#fbf6ea'], dark: ['fixed', '#5b4330'], sign: ['fixed', '#fdf6e3'],
      egg: ['fixed', '#f8eed6'], leaf: ['fixed', '#97b36f'], leaf2: ['fixed', '#7d9d5c'], trunk: ['fixed', '#8d6a45'],
      grass: ['fixed', '#d3deae'], grass2: ['fixed', '#c9d5a2'], road: ['fixed', '#e2d3b4'], plaza: ['fixed', '#ece0c6'],
      water: ['fixed', '#b4d6d6'], sand: ['fixed', '#ead9b2'], crop: ['fixed', '#a9c46c'], crop2: ['fixed', '#e3c46e'],
      soil: ['fixed', '#c09b70'], edge: ['fixed', '#b79a70'],
    },
  },

  sketch: {
    key: 'sketch', name: '手绘', en: 'Ink & wash', tag: '应用',
    pitch: '墨线加水彩：线条带一点手的起伏，颜色像刷上去的，纸纹从底下透出来。配合 pen 的手绘模式使用。',
    keywords: ['墨线', '水彩', '纸纹', '手写字'],
    pros: ['有温度，长时间看不累', '颜色淡、对比靠墨线，信息层次清楚', '和纸艺同一家族，世界观不变'],
    cons: ['线条有起伏，小图标要控制细节', '需要手写字体，首次加载多几个字体分片'],
    ui: {
      bg: '#f4eee2', panel: '#fcf8f0', panel2: '#f3ecdf', ink: '#2f261d', muted: '#857560', line: 'rgba(84,62,40,.2)',
      brand: '#c2663f', brandInk: '#fffaf2', ok: '#6b9160', warn: '#c38b2e', bad: '#b9543f',
      font: '"LXGW WenKai Screen","PingFang SC","Hiragino Sans GB",system-ui,sans-serif',
      head: '"LXGW WenKai Screen","Songti SC","STSong",serif',
      radius: '14px', border: '1px solid transparent', shadow: '0 12px 28px -18px rgba(80,55,30,.45)', headCase: 'none',
    },
    stroke: ['fixed', 'rgba(52,36,22,.6)'], strokeW: 0.9, shade: [20, 15],
    ink: 'rgba(46,31,18,.74)', inkW: 1.05,
    text: '#3a2c1e', smoke: '#fffaf2', hl: 'rgba(255,255,255,.5)', beam: 'rgba(255,236,170,.45)',
    mats: {
      wall: ['mix', 13, '#f6efe2'], roof: ['mix', 78, '#6b4b33'], acc: ['acc'], acc2: ['fixed', '#c9644c'],
      base: ['fixed', '#e0d0ae'], win: ['fixed', '#6f5b45'], glass: ['mix', 16, '#d9e9e5'], metal: ['fixed', '#aaa498'],
      wood: ['fixed', '#c7a072'], white: ['fixed', '#fcf8ee'], dark: ['fixed', '#5e4734'], sign: ['fixed', '#fdf7e6'],
      egg: ['fixed', '#f8efda'], leaf: ['fixed', '#a2bc7c'], leaf2: ['fixed', '#89a868'], trunk: ['fixed', '#8f6c48'],
      grass: ['fixed', '#dce4bd'], grass2: ['fixed', '#dce4bd'], road: ['fixed', '#ebdfc7'], plaza: ['fixed', '#f0e7d4'],
      water: ['fixed', '#c0dcd7'], sand: ['fixed', '#eddfbb'], crop: ['fixed', '#aec877'], crop2: ['fixed', '#e7ca7b'],
      soil: ['fixed', '#c8a479'], edge: ['fixed', '#c3a67e'],
    },
  },

  day: {
    key: 'day', name: '白昼', en: 'Daylight flat',
    pitch: '明亮干净的扁平色块，像一款休闲经营游戏，第一眼最友好。',
    keywords: ['扁平', '高明度', '无描边', '游戏感'],
    pros: ['最"像产品"，同学第一次打开不会有门槛', '颜色区分度高，区域一眼分清', '实现最简单，不需要纹理和特效'],
    cons: ['和其他休闲游戏容易撞脸，辨识度一般', '和"纸"的主题没有直接关系'],
    ui: {
      bg: '#eef3f7', panel: '#ffffff', panel2: '#f3f6f9', ink: '#1f2a35', muted: '#6a7887', line: '#dfe6ec',
      brand: '#2f7de1', brandInk: '#ffffff', ok: '#2fa36b', warn: '#e8932f', bad: '#e5534b',
      font: '"PingFang SC","Hiragino Sans GB",system-ui,sans-serif',
      head: '"PingFang SC","Hiragino Sans GB",system-ui,sans-serif',
      radius: '14px', border: '1px solid #e3e9ee', shadow: '0 8px 24px rgba(31,42,53,.10)', headCase: 'none',
    },
    stroke: null, strokeW: 0, shade: [28, 13],
    text: '#22303c', smoke: '#ffffff', hl: 'rgba(255,255,255,.5)', beam: 'rgba(255,240,170,.55)',
    mats: {
      wall: ['mix', 9, '#ffffff'], roof: ['acc'], acc: ['acc'], acc2: ['fixed', '#ff6b5b'],
      base: ['fixed', '#e3e7eb'], win: ['fixed', '#8ecdf2'], glass: ['mix', 15, '#c4e8ff'], metal: ['fixed', '#a9b4c0'],
      wood: ['fixed', '#d6a575'], white: ['fixed', '#ffffff'], dark: ['fixed', '#4a5560'], sign: ['fixed', '#ffffff'],
      egg: ['fixed', '#fff3d6'], leaf: ['fixed', '#7bc96f'], leaf2: ['fixed', '#5cb35a'], trunk: ['fixed', '#a07850'],
      grass: ['fixed', '#bfe3a0'], grass2: ['fixed', '#b4dc93'], road: ['fixed', '#eceff3'], plaza: ['fixed', '#f6efe4'],
      water: ['fixed', '#7cc7ea'], sand: ['fixed', '#f3e3b5'], crop: ['fixed', '#9ad06b'], crop2: ['fixed', '#f2c94c'],
      soil: ['fixed', '#c99b6b'], edge: ['fixed', '#9c7b55'],
    },
  },

  blueprint: {
    key: 'blueprint', name: '蓝图', en: 'Blueprint',
    pitch: '工程蓝图上的线稿城市：深蓝底、白色线框、等宽字体，强调"系统设计"。',
    keywords: ['线框', '等宽字体', '工程感', '深蓝'],
    pros: ['技术感最强，适合讲架构和数据流', '线框天然突出物流路线和连接关系', '不依赖美术细节，粗糙也像"设计稿"'],
    cons: ['长时间使用偏冷、偏累', '建筑之间靠线条区分，信息多时容易乱'],
    ui: {
      bg: '#0e3560', panel: 'rgba(9,38,72,.9)', panel2: 'rgba(255,255,255,.06)', ink: '#e4f1ff', muted: '#8fb3d8',
      line: 'rgba(190,225,255,.38)', brand: '#ffd166', brandInk: '#0e3560', ok: '#7ee0a1', warn: '#ffd166', bad: '#ff8a7a',
      font: '"SF Mono",Menlo,"PingFang SC",monospace', head: '"SF Mono",Menlo,"PingFang SC",monospace',
      radius: '3px', border: '1px dashed rgba(190,225,255,.5)', shadow: 'none', headCase: 'uppercase',
    },
    stroke: ['fixed', 'rgba(220,238,255,.9)'], strokeW: 0.9, shade: [6, 18],
    text: '#e4f1ff', smoke: 'rgba(220,238,255,.35)', hl: 'rgba(255,255,255,.15)', beam: 'rgba(255,209,102,.3)',
    mats: {
      wall: ['fixed', 'rgba(120,180,240,.18)'], roof: ['fixed', 'rgba(255,209,102,.22)'], acc: ['fixed', 'rgba(255,209,102,.3)'],
      acc2: ['fixed', 'rgba(255,138,122,.4)'], base: ['fixed', 'rgba(255,255,255,.07)'], win: ['fixed', 'rgba(214,236,255,.55)'],
      glass: ['fixed', 'rgba(140,220,255,.25)'], metal: ['fixed', 'rgba(255,255,255,.14)'], wood: ['fixed', 'rgba(255,255,255,.1)'],
      white: ['fixed', 'rgba(255,255,255,.2)'], dark: ['fixed', 'rgba(5,20,40,.6)'], sign: ['fixed', 'rgba(9,38,72,.9)'],
      egg: ['fixed', 'rgba(255,209,102,.3)'], leaf: ['fixed', 'rgba(126,224,161,.2)'], leaf2: ['fixed', 'rgba(126,224,161,.14)'],
      trunk: ['fixed', 'rgba(255,255,255,.12)'], grass: ['fixed', 'rgba(255,255,255,.03)'], grass2: ['fixed', 'rgba(255,255,255,.05)'],
      road: ['fixed', 'rgba(255,255,255,.13)'], plaza: ['fixed', 'rgba(255,255,255,.08)'], water: ['fixed', 'rgba(110,200,255,.2)'],
      sand: ['fixed', 'rgba(255,255,255,.06)'], crop: ['fixed', 'rgba(126,224,161,.22)'], crop2: ['fixed', 'rgba(255,209,102,.22)'],
      soil: ['fixed', 'rgba(255,255,255,.06)'], edge: ['fixed', 'rgba(5,20,40,.5)'],
    },
  },

  night: {
    key: 'night', name: '夜间实验室', en: 'Midnight lab',
    pitch: '凌晨两点还亮着灯的科研小镇：深色底、发光窗户、霓虹物流线，PhD 一看就懂。',
    keywords: ['深色', '发光', '霓虹', '熬夜梗'],
    pros: ['氛围感最强，"凌晨的实验室"是 PhD 共同记忆', '发光的物流线和窗户让"系统在运转"非常直观', '深色界面长时间看更舒服'],
    cons: ['教室投影机上暗部容易糊，需要提高亮度', '发光特效多了会卡，需要控制数量'],
    ui: {
      bg: '#0c1018', panel: '#141a25', panel2: '#1b2230', ink: '#e7edf5', muted: '#8a97a8', line: '#283244',
      brand: '#8b6cff', brandInk: '#ffffff', ok: '#3fcf8e', warn: '#f5b942', bad: '#ff6b7a',
      font: '"PingFang SC","Hiragino Sans GB",system-ui,sans-serif',
      head: '"PingFang SC","Hiragino Sans GB",system-ui,sans-serif',
      radius: '12px', border: '1px solid #263044', shadow: '0 0 0 1px rgba(139,108,255,.12),0 10px 30px rgba(0,0,0,.45)', headCase: 'none',
    },
    stroke: ['alpha', 0.5], strokeW: 0.8, shade: [10, 30],
    text: '#ffe7a8', smoke: 'rgba(120,130,150,.6)', hl: 'rgba(255,255,255,.12)', beam: 'rgba(255,211,107,.35)',
    mats: {
      wall: ['mix', 14, '#1a2130'], roof: ['mix', 45, '#121826'], acc: ['acc'], acc2: ['fixed', '#ff5d73'],
      base: ['fixed', '#1d2331'], win: ['fixed', '#ffd36b'], glass: ['mix', 30, '#1b3a4a'], metal: ['fixed', '#3a4357'],
      wood: ['fixed', '#4a3a2e'], white: ['fixed', '#9aa7bd'], dark: ['fixed', '#0b0e14'], sign: ['fixed', '#232b3b'],
      egg: ['fixed', '#f1e2b8'], leaf: ['fixed', '#1f4a3a'], leaf2: ['fixed', '#1a3f32'], trunk: ['fixed', '#3b2f26'],
      grass: ['fixed', '#13241f'], grass2: ['fixed', '#112019'], road: ['fixed', '#1c2230'], plaza: ['fixed', '#1a2030'],
      water: ['fixed', '#0d2a3d'], sand: ['fixed', '#2a2a24'], crop: ['fixed', '#2a5a3a'], crop2: ['fixed', '#6a5a20'],
      soil: ['fixed', '#2a2018'], edge: ['fixed', '#06080c'],
    },
  },
};

export const THEME_ORDER = ['paper', 'day', 'blueprint', 'night'];

// ---------- CSS for the browser ----------

function specCSS(spec) {
  switch (spec[0]) {
    case 'acc': return 'var(--accent)';
    case 'mix': return `color-mix(in srgb,var(--accent) ${spec[1]}%,${spec[2]})`;
    case 'alpha': return `color-mix(in srgb,var(--accent) ${spec[1] * 100}%,transparent)`;
    default: return spec[1];
  }
}

export function themeCSS(t) {
  const s = `.theme-${t.key}`;
  const u = t.ui;
  let css = `${s}{--bg:${u.bg};--panel:${u.panel};--panel2:${u.panel2};--ink:${u.ink};--muted:${u.muted};--line:${u.line};` +
    `--brand:${u.brand};--brand-ink:${u.brandInk};--ok:${u.ok};--warn:${u.warn};--bad:${u.bad};--font:${u.font};--head:${u.head};` +
    `--radius:${u.radius};--pborder:${u.border};--pshadow:${u.shadow};--hcase:${u.headCase}}`;
  for (const [m, spec] of Object.entries(t.mats)) css += `${s} .m-${m}{--c:${specCSS(spec)}}`;
  css += `${s} .f-l{fill:var(--c)}${s} .f-t{fill:color-mix(in srgb,var(--c),white ${t.shade[0]}%)}` +
    `${s} .f-r{fill:color-mix(in srgb,var(--c),black ${t.shade[1]}%)}`;
  // hand-drawn sprites: the wash carries no stroke, the separate ink line does
  const shapes = `:is(polygon,path,ellipse,circle,rect):not(.ln):not(.ln2):not(.hl):not(.smoke):not(.beam):not(.shadow):not(.nost):not(.ink)${t.ink ? ':not(.wash)' : ''}`;
  css += t.stroke
    ? `${s} .sp ${shapes}{stroke:${specCSS(t.stroke)};stroke-width:${t.strokeW};stroke-linejoin:round}`
    : `${s} .sp ${shapes}{stroke:none}`;
  css += t.ink
    ? `${s} .sp .ink{fill:none;stroke:${t.ink};stroke-width:${t.inkW};stroke-linecap:round;stroke-linejoin:round}${s} .sp .ink-s{stroke-width:${t.inkW * 0.7};opacity:.7}${s} .sp .wash{stroke:none}`
    : `${s} .sp .ink{display:none}`;
  css += `${s} .sp .t-sign{fill:${t.text}}${s} .sp .smoke{fill:${t.smoke}}${s} .sp .hl{fill:${t.hl}}${s} .sp .beam{fill:${t.beam}}`;
  return css;
}

// ---------- resolved colours for the exported SVG files ----------

function parseC(c) {
  if (c === 'transparent') return [0, 0, 0, 0];
  if (c[0] === '#') {
    const h = c.slice(1);
    const n = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), n.length === 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1];
  }
  const p = c.match(/\(([^)]+)\)/)[1].split(',').map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

// CSS color-mix interpolates premultiplied alpha; do the same so exports match the page.
function mixC(a, pa, b) {
  const alpha = a[3] * pa + b[3] * (1 - pa);
  if (alpha === 0) return [0, 0, 0, 0];
  const ch = i => (a[i] * a[3] * pa + b[i] * b[3] * (1 - pa)) / alpha;
  return [ch(0), ch(1), ch(2), alpha];
}

function toC([r, g, b, a]) {
  const hex = v => Math.round(v).toString(16).padStart(2, '0');
  return a >= 0.999 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;
}

function specColor(spec, accent) {
  const acc = parseC(accent);
  switch (spec[0]) {
    case 'acc': return acc;
    case 'mix': return mixC(acc, spec[1] / 100, parseC(spec[2]));
    case 'alpha': return [acc[0], acc[1], acc[2], spec[1]];
    default: return parseC(spec[1]);
  }
}

export function resolveSVG(markup, accent, t) {
  const WHITE = [255, 255, 255, 1], BLACK = [0, 0, 0, 1];
  const stroke = t.stroke ? toC(specColor(t.stroke, accent)) : null;
  return markup.replace(/<(polygon|path|ellipse|circle|rect|text)\b([^>]*?)class="([^"]*)"/g, (all, tag, pre, cls) => {
    const c = cls.split(/\s+/);
    const add = [];
    if (tag === 'text') {
      if (c.includes('t-sign')) add.push(`fill="${t.text}"`);
      if (c.includes('t-inv')) add.push('fill="#ffffff"');
      return `<${tag}${pre}${add.join(' ')} class="${cls}"`;
    }
    if (c.includes('shadow')) return `<${tag}${pre}fill="rgba(0,0,0,.14)" class="${cls}"`;
    if (c.includes('hl')) return `<${tag}${pre}fill="${t.hl}" class="${cls}"`;
    if (c.includes('smoke')) return `<${tag}${pre}fill="${t.smoke}" class="${cls}"`;
    if (c.includes('beam')) return `<${tag}${pre}fill="${t.beam}" class="${cls}"`;
    const m = c.find(x => x.startsWith('m-'));
    if (!m) return all;
    const base = specColor(t.mats[m.slice(2)], accent);
    if (c.includes('ln') || c.includes('ln2')) {
      return `<${tag}${pre}fill="none" stroke="${toC(base)}" stroke-width="${c.includes('ln2') ? 3 : 1.6}" stroke-linecap="round" stroke-linejoin="round" class="${cls}"`;
    }
    let col = base;
    if (c.includes('f-t')) col = mixC(base, 1 - t.shade[0] / 100, WHITE);
    if (c.includes('f-r')) col = mixC(base, 1 - t.shade[1] / 100, BLACK);
    add.push(`fill="${toC(col)}"`);
    if (stroke && !c.includes('nost')) add.push(`stroke="${stroke}" stroke-width="${t.strokeW}" stroke-linejoin="round"`);
    return `<${tag}${pre}${add.join(' ')} class="${cls}"`;
  });
}
