// The PC's own pictures of a board (boardrender.py runs this page in a hidden Chrome on the PC).
// It draws any part of a board from what the PC stores, with the iPad's own stroke code
// (board.js), so the voice and the main agent can see the user's screen, the changes and any
// rectangle without asking the iPad (which may be asleep) and without costing it anything.
//
// It keeps its own copy of each board and asks the server only for what changed since (the same
// ink batches the iPad syncs with), so a picture costs the same however big the board is. Stroke
// outlines, drawings and card pictures are made once and reused.
//
// window.canvasRender(spec) -> {dataUrl, width, height, tiles, ms}
// window.canvasRenderMany([spec, ...]) -> [result, ...]   (one board sync, several pictures)
// window.canvasSync(board) -> ms                           (bring the copy up to date now)
//
// spec: {board, tiles: [{rect: [x0, y0, x1, y1], label?, scale?}], since, tileMax, width,
//        maxScale, bare, format: 'png'|'jpeg', quality, itemAlpha}
// Tiles are drawn side by side (rows, at most `width` px wide), each with a strip naming its world
// rectangle; `bare` draws one tile alone with no strip (the user's screen). Ink drawn after
// `since` (ms) is full strength, older ink fainter, as in the iPad's own snapshots.
import { parseStroke, paintStroke, prepareStroke } from './board.js';
import { sanitizeSvg } from './claude-layer.js';
import { withKey } from './api.js';
import { BAR } from './livecards.js';

const OLD_INK_ALPHA = 0.35;
const ITEM_ALPHA = 0.85;
const STRIP = 28;
const GAP = 14;
const PAPER = '#ffffff';
const FONT = '-apple-system, "Segoe UI", system-ui, sans-serif';

const boards = new Map(); // board -> {id, rev, strokes, layer, layerSig}
const now = () => performance.now();

// ---- the board's copy: only what changed since the last look comes over
function applyOps(b, ops) {
  const out = b.strokes;
  let index = null;
  const idx = () => {
    if (!index) { index = new Map(); out.forEach((s, i) => { if (s) index.set(s.id, i); }); }
    return index;
  };
  for (const o of ops) {
    if (!o || typeof o !== 'object') continue;
    if (o.op === 'del') {
      const i = idx().get(o.id);
      if (i === undefined) continue;
      out[i] = null;
      index.delete(o.id);
    } else if (o.op === 'put') {
      const s = parseStroke(o.s);
      if (!s) continue;
      s._src = stampOf(o.s);
      const i = idx().get(s.id);
      if (i !== undefined) { out[i] = s; continue; }
      const j = !('after' in o) ? out.length - 1 : o.after == null ? -1 : idx().get(o.after);
      if (j === undefined || j === out.length - 1) {
        out.push(s);
        index.set(s.id, out.length - 1);
      } else {
        out.splice(j + 1, 0, s); // rare: an undo restoring a stroke mid-stack
        index = null;
      }
    }
  }
  b.strokes = out.filter(Boolean);
}

async function sync(board) {
  let b = boards.get(board);
  if (!b) {
    b = { id: '', rev: -1, strokes: [], layer: [], layerSig: '' };
    boards.set(board, b);
  }
  const q = `s=${encodeURIComponent(board)}&since=${b.rev}&id=${encodeURIComponent(b.id)}&layer=${encodeURIComponent(b.layerSig)}`;
  const res = await fetch(withKey(`/api/render/data?${q}`), { cache: 'no-store' });
  if (!res.ok) throw new Error(`board data: HTTP ${res.status}`);
  const d = await res.json();
  const ink = d.ink || {};
  if (Array.isArray(ink.strokes)) { // the whole board: first look, another board, or too far behind
    const old = new Map(b.strokes.map((s) => [s.id, s]));
    b.strokes = [];
    for (const o of ink.strokes) {
      const prev = o && old.get(o.id);
      // the same stroke as before keeps its outline (made once, when first drawn)
      if (prev && prev._src === stampOf(o)) { b.strokes.push(prev); continue; }
      const s = parseStroke(o);
      if (s) { s._src = stampOf(o); b.strokes.push(s); }
    }
  } else {
    for (const batch of ink.batches || []) applyOps(b, batch.ops || []);
  }
  // every stroke's outline now (a whole board: once, at warm-up), so pictures only paint
  for (const s of b.strokes) if (!s._path) prepareStroke(s);
  b.id = ink.id || b.id;
  b.rev = Number.isFinite(ink.rev) ? ink.rev : b.rev;
  if (Array.isArray(d.layer)) b.layer = d.layer;
  b.layerSig = d.layer_sig || '';
  return b;
}

function stampOf(o) {
  const p = o.pts || [];
  return `${o.t0 || 0}:${o.t1 || 0}:${o.mt || 0}:${p.length}:${p[0]}:${p[1]}:${p[p.length - 2]}:${o.color}:${o.size}`;
}

// ---- pictures of drawings and cards, made once and reused
const pics = new Map(); // key -> Promise<img|null>
function remember(key, make) {
  if (!pics.has(key)) {
    if (pics.size > 300) pics.delete(pics.keys().next().value);
    pics.set(key, make());
  }
  return pics.get(key);
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + s.length;
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
  try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

const ratios = new Map();
const lastFrame = new Map(); // browser tab -> its last frame
function svgRatio(markup) {
  const k = hash(markup.slice(0, 2000));
  if (!ratios.has(k)) {
    const m = /viewBox\s*=\s*"\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(markup.slice(0, 2000));
    ratios.set(k, m && +m[1] > 0 ? +m[2] / +m[1] : 0.75);
  }
  return ratios.get(k);
}

// A card: its frame and title strip, then what it shows when the PC has a picture of it. Live
// pictures (a page's shot, a browser's frame) are fetched each time: they change on their own.
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
    pic = await loadImage(`/live/${it.page}/shot.png?w=${Math.round(w)}&h=${Math.round(h - BAR)}`, 1500);
  } else if (it.type === 'browser') {
    // the newest frame if its tab is open (never opens one, never waits), else the last one seen
    const tab = (it.browsing && it.browsing.browser) || it.browser;
    if (tab) {
      pic = await loadImage(withKey(`/api/browser/${tab}/frame?peek=1&s=${encodeURIComponent(board)}`), 1000);
      if (pic) lastFrame.set(tab, pic);
      else pic = lastFrame.get(tab) || null;
    }
  } else if (it.poster) {
    pic = await remember(`poster|${it.poster}`, () => loadImage(withKey(it.poster)));
  }
  if (pic) ctx.drawImage(pic, r[0], r[1] + BAR, w, h - BAR);
}

async function drawTile(ctx, b, tile, scale, ox, oy, since, board, itemAlpha) {
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
  for (const it of b.layer) {
    const ratio = it.svg ? svgRatio(it.svg) : null;
    const r = itemRect(it, ratio);
    if (!meets(r, rect)) continue;
    ctx.globalAlpha = itemAlpha;
    try {
      if (it.svg) {
        // drawn at a size rounded up to a step, so small zoom changes reuse the same picture
        const step = (n) => Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, n))));
        const pw2 = step((r[2] - r[0]) * scale), ph2 = Math.max(1, Math.round(pw2 * (r[3] - r[1]) / Math.max(1, r[2] - r[0])));
        const img = await remember(`svg|${it.id}|${hash(it.svg)}|${pw2}`, () => svgImage(it.svg, pw2, ph2));
        if (img) ctx.drawImage(img, r[0], r[1], r[2] - r[0], r[3] - r[1]);
      } else if (it.type && it.type !== 'image') {
        await drawCard(ctx, it, r, board);
      } else if (it.src) {
        const img = await remember(`img|${it.src}`, () => loadImage(withKey(it.src)));
        if (img) ctx.drawImage(img, r[0], r[1], r[2] - r[0], r[3] - r[1]);
      }
      items++;
    } catch { /* one bad item doesn't spoil the picture */ }
    ctx.globalAlpha = 1;
  }
  for (const s of b.strokes) {
    if (!meets(s._bbox, rect)) continue;
    paintStroke(ctx, s, 'light', since == null || Math.max(s.t0 || 0, s.mt || 0) > since ? 1 : OLD_INK_ALPHA);
    strokes++;
  }
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!tile.bare) {
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, pw - 1, ph - 1);
    if (!items && !strokes) {
      ctx.fillStyle = '#8e8e93';
      ctx.font = `15px ${FONT}`;
      ctx.fillText('empty now: something here was erased, moved or removed', ox + 12, oy + 24);
    }
  }
  return { items, strokes };
}

async function draw(b, { board, tiles, since = null, tileMax = 1000, width = 2000, maxScale = 2, bare = false,
  format = 'png', quality = 0.85, itemAlpha = ITEM_ALPHA, cpu = true }) {
  const t0 = now();
  const strip = bare ? 0 : STRIP, gap = bare ? 0 : GAP;
  // each tile's scale, then rows (shelf packing) no wider than `width`
  const laid = tiles.map((t, i) => {
    const ww = Math.max(1, t.rect[2] - t.rect[0]), wh = Math.max(1, t.rect[3] - t.rect[1]);
    const scale = t.scale > 0 ? t.scale : Math.min(maxScale, tileMax / Math.max(ww, wh));
    return { ...t, bare, n: i + 1, scale, w: Math.round(ww * scale), h: Math.round(wh * scale) };
  });
  const order = laid.slice().sort((a, b2) => b2.h - a.h);
  let x = 0, y = 0, rowH = 0, W = 0;
  for (const t of order) {
    if (x > 0 && x + t.w > width) { x = 0; y += rowH + gap; rowH = 0; }
    t.ox = x; t.oy = y + strip;
    x += t.w + gap;
    rowH = Math.max(rowH, t.h + strip);
    W = Math.max(W, x - gap);
  }
  const H = y + rowH;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, W);
  canvas.height = Math.max(1, H);
  // drawn by the processor: in headless Chrome it beats the GPU path (24 vs 35 ms for a screen,
  // 58 vs 94 ms for a 6-tile map, measured 2026-11-13) and has no slow first picture
  const ctx = canvas.getContext('2d', cpu ? { willReadFrequently: true } : undefined);
  ctx.fillStyle = '#e9e9ee';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const out = [];
  for (const t of laid) {
    if (!bare) {
      ctx.fillStyle = '#1d1d1f';
      ctx.font = `600 15px ${FONT}`;
      const [x0, y0, x1, y1] = t.rect.map((v) => Math.round(v));
      ctx.fillText(`${laid.length > 1 ? `#${t.n}  ` : ''}${t.label ? `${t.label}  ` : ''}x ${x0}..${x1}, y ${y0}..${y1}`, t.ox + 2, t.oy - 9);
    }
    const got = await drawTile(ctx, b, t, t.scale, t.ox, t.oy, since, board, itemAlpha);
    out.push({ n: t.n, rect: t.rect, px: [t.ox, t.oy, t.w, t.h], scale: +t.scale.toFixed(4), ...got });
  }
  const t1 = now();
  const dataUrl = format === 'jpeg' ? canvas.toDataURL('image/jpeg', quality) : canvas.toDataURL('image/png');
  canvas.width = canvas.height = 0;
  return { dataUrl, width: W, height: H, tiles: out, ms: { draw: Math.round(t1 - t0), encode: Math.round(now() - t1) } };
}

window.canvasRenderMany = async (specs) => {
  const t0 = now();
  const b = await sync(specs[0].board);
  const syncMs = Math.round(now() - t0);
  const res = [];
  for (const spec of specs) {
    const r = await draw(b, spec);
    r.ms.sync = syncMs;
    res.push(r);
  }
  return res;
};
window.canvasRender = async (spec) => (await window.canvasRenderMany([spec]))[0];
window.canvasSync = async (board) => {
  const t0 = now();
  await sync(board);
  return Math.round(now() - t0);
};
window.canvasRenderReady = true;
