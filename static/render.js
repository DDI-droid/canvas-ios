// The PC's own pictures of a board (boardrender.py runs this page in a hidden Chrome on the PC).
// It draws any part of a board from what the PC stores, with the iPad's own stroke code
// (board.js), so the voice and the main agent can see changes and any rectangle without asking
// the iPad (which may be asleep) and without costing it anything.
//
// window.canvasRender({board, rev, tiles: [{rect: [x0, y0, x1, y1], label}], since, tileMax, width})
//   -> {dataUrl, width, height, tiles: [{n, rect, px: [x, y, w, h], scale, strokes, items}]}
// Tiles are drawn side by side (rows, at most `width` px wide), each with a strip naming its
// world rectangle. Ink drawn after `since` (ms) is full strength, older ink fainter, as in the
// iPad's own snapshots.
import { parseStroke, paintStroke } from './board.js';
import { sanitizeSvg } from './claude-layer.js';
import { withKey } from './api.js';
import { BAR } from './livecards.js';

const OLD_INK_ALPHA = 0.35;
const ITEM_ALPHA = 0.85;
const STRIP = 28;
const GAP = 14;
const PAPER = '#ffffff';
const FONT = '-apple-system, "Segoe UI", system-ui, sans-serif';

let data = { board: null, rev: null, strokes: [], items: [] };

async function load(board, rev) {
  if (data.board === board && data.rev === rev && rev != null) return data;
  const res = await fetch(withKey(`/api/render/data?s=${encodeURIComponent(board)}`));
  if (!res.ok) throw new Error(`board data: HTTP ${res.status}`);
  const d = await res.json();
  const strokes = [];
  for (const o of d.strokes || []) {
    const s = parseStroke(o);
    if (s) strokes.push(s);
  }
  data = { board, rev: d.rev, strokes, items: d.layer || [] };
  return data;
}

const meets = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

function itemRect(it, svgSize) {
  const x = +it.x || 0, y = +it.y || 0, w = +it.width > 0 ? +it.width : 400;
  let h = +it.height > 0 ? +it.height : 0;
  if (!h) h = svgSize ? w * svgSize : w * (+it.aspect > 0 ? +it.aspect : 0.66) + (it.type ? BAR : 0);
  return [x, y, x + w, y + h];
}

function loadImage(src, ms = 4000) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(null), ms);
    img.onload = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = src;
  });
}

async function svgImage(markup, pw, ph) {
  const svg = sanitizeSvg(markup);
  if (!svg) return null;
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const ratio = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[3] / vb[2] : null;
  if (!ratio) svg.setAttribute('viewBox', `0 0 ${parseFloat(svg.getAttribute('width')) || 300} ${parseFloat(svg.getAttribute('height')) || 150}`);
  svg.setAttribute('width', String(pw));
  svg.setAttribute('height', String(ph));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  try { return { img: await loadImage(url), ratio }; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function svgRatio(markup) {
  const m = /viewBox\s*=\s*"\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(markup.slice(0, 2000));
  return m && +m[1] > 0 ? +m[2] / +m[1] : 0.75;
}

// A card: its frame and title strip, then what it shows when the PC has a picture of it.
async function drawCard(ctx, it, r, board) {
  const w = r[2] - r[0], h = r[3] - r[1];
  ctx.fillStyle = '#f6f6f8';
  ctx.fillRect(r[0], r[1], w, BAR);
  ctx.fillStyle = it.type === 'video' ? '#111' : '#fff';
  ctx.fillRect(r[0], r[1] + BAR, w, h - BAR);
  ctx.strokeStyle = 'rgba(0,0,0,.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(r[0], r[1], w, h);
  ctx.fillStyle = '#3a3a3c';
  ctx.font = `600 14px ${FONT}`;
  const kind = { video: 'Video', page: 'Live page', browser: 'Browser', model: '3D model' }[it.type] || 'Card';
  const title = it.label || (it.browsing && it.browsing.url) || it.url || '';
  ctx.fillText(`${kind}: ${title}`.slice(0, 90), r[0] + 10, r[1] + 20);
  let pic = null;
  if (it.type === 'page' && it.page) {
    pic = await loadImage(`/live/${it.page}/shot.png?w=${Math.round(w)}&h=${Math.round(h - BAR)}`);
  } else if (it.type === 'browser') {
    const tab = (it.browsing && it.browsing.browser) || it.browser;
    if (tab) pic = await loadImage(withKey(`/api/browser/${tab}/frame?after=0&s=${encodeURIComponent(board)}`), 2500);
  } else if (it.poster) {
    pic = await loadImage(withKey(it.poster));
  }
  if (pic) ctx.drawImage(pic, r[0], r[1] + BAR, w, h - BAR);
}

async function drawTile(ctx, tile, scale, ox, oy, since, board) {
  const rect = tile.rect;
  const pw = Math.round((rect[2] - rect[0]) * scale), ph = Math.round((rect[3] - rect[1]) * scale);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, pw, ph);
  ctx.clip();
  ctx.fillStyle = PAPER;
  ctx.fillRect(ox, oy, pw, ph);
  ctx.setTransform(scale, 0, 0, scale, ox - rect[0] * scale, oy - rect[1] * scale);
  let items = 0, strokes = 0;
  for (const it of data.items) {
    const ratio = it.svg ? svgRatio(it.svg) : null;
    const r = itemRect(it, ratio);
    if (!meets(r, rect)) continue;
    ctx.globalAlpha = ITEM_ALPHA;
    try {
      if (it.svg) {
        const s = await svgImage(it.svg, Math.max(1, Math.round((r[2] - r[0]) * scale)), Math.max(1, Math.round((r[3] - r[1]) * scale)));
        if (s && s.img) ctx.drawImage(s.img, r[0], r[1], r[2] - r[0], r[3] - r[1]);
      } else if (it.type && it.type !== 'image') {
        await drawCard(ctx, it, r, board);
      } else if (it.src) {
        const img = await loadImage(withKey(it.src));
        if (img) ctx.drawImage(img, r[0], r[1], r[2] - r[0], r[3] - r[1]);
      }
      items++;
    } catch { /* one bad item doesn't spoil the picture */ }
    ctx.globalAlpha = 1;
  }
  for (const s of data.strokes) {
    if (!meets(s._bbox, rect)) continue;
    paintStroke(ctx, s, 'light', since == null || Math.max(s.t0 || 0, s.mt || 0) > since ? 1 : OLD_INK_ALPHA);
    strokes++;
  }
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, oy + 0.5, pw - 1, ph - 1);
  if (!items && !strokes) {
    ctx.fillStyle = '#8e8e93';
    ctx.font = `15px ${FONT}`;
    ctx.fillText('empty now: something here was erased, moved or removed', ox + 12, oy + 24);
  }
  return { items, strokes };
}

window.canvasRender = async ({ board, rev = null, tiles, since = null, tileMax = 1000, width = 2000, maxScale = 2 }) => {
  await load(board, rev);
  // each tile's scale, then rows (shelf packing) no wider than `width`
  const laid = tiles.map((t, i) => {
    const ww = Math.max(1, t.rect[2] - t.rect[0]), wh = Math.max(1, t.rect[3] - t.rect[1]);
    const scale = Math.min(maxScale, tileMax / Math.max(ww, wh));
    return { ...t, n: i + 1, scale, w: Math.round(ww * scale), h: Math.round(wh * scale) };
  });
  const order = laid.slice().sort((a, b) => b.h - a.h);
  let x = 0, y = 0, rowH = 0, W = 0;
  for (const t of order) {
    if (x > 0 && x + t.w > width) { x = 0; y += rowH + GAP; rowH = 0; }
    t.ox = x; t.oy = y + STRIP;
    x += t.w + GAP;
    rowH = Math.max(rowH, t.h + STRIP);
    W = Math.max(W, x - GAP);
  }
  const H = y + rowH;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, W);
  canvas.height = Math.max(1, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e9e9ee';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const out = [];
  for (const t of laid) {
    ctx.fillStyle = '#1d1d1f';
    ctx.font = `600 15px ${FONT}`;
    const [x0, y0, x1, y1] = t.rect.map((v) => Math.round(v));
    ctx.fillText(`${laid.length > 1 ? `#${t.n}  ` : ''}${t.label ? `${t.label}  ` : ''}x ${x0}..${x1}, y ${y0}..${y1}`, t.ox + 2, t.oy - 9);
    const got = await drawTile(ctx, t, t.scale, t.ox, t.oy, since, board);
    out.push({ n: t.n, rect: t.rect, px: [t.ox, t.oy, t.w, t.h], scale: +t.scale.toFixed(4), ...got });
  }
  const dataUrl = canvas.toDataURL('image/png');
  canvas.width = canvas.height = 0;
  return { dataUrl, width: W, height: H, tiles: out };
};
window.canvasRenderReady = true;
