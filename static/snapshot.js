// Builds the PNG snapshot sent to Claude plus the per-message timeline.
import { paintStroke } from './board.js';
import { colorName, PAPER } from './palette.js';
import { clamp, unionRect } from './util.js';

const MAX_SIDE = 2000;
const OLD_INK_ALPHA = 0.35;
const CLAUDE_ALPHA = 0.55;
const GROUP_GAP_MS = 1500;

function isNew(s, since) {
  return Math.max(s.t0 || 0, s.mt || 0) > since;
}

export async function buildSnapshot({ board, layer, mode, since }) {
  let rect;
  if (mode === 'board') {
    const r = unionRect(board.contentBounds(), layer.bounds());
    if (r) {
      const pad = 36;
      rect = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
    }
  }
  if (!rect) {
    mode = mode === 'board' ? 'board' : 'view';
    rect = board.viewRect();
  }
  const ww = Math.max(1, rect[2] - rect[0]);
  const wh = Math.max(1, rect[3] - rect[1]);
  let scale = MAX_SIDE / Math.max(ww, wh);
  if (mode === 'board') scale = Math.min(scale, 3);
  scale = clamp(scale, 0.05, 24);
  const W = Math.max(1, Math.round(ww * scale));
  const H = Math.max(1, Math.round(wh * scale));

  const fresh = board.strokes.filter((s) => isNew(s, since));
  const render = async (withClaude) => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = PAPER.light;
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(scale, 0, 0, scale, -rect[0] * scale, -rect[1] * scale);
    let items = 0;
    if (withClaude) {
      try { items = await layer.drawInto(ctx, rect, scale, CLAUDE_ALPHA); } catch { items = 0; }
    }
    for (const s of board.strokes) paintStroke(ctx, s, 'light', isNew(s, since) ? 1 : OLD_INK_ALPHA);
    try {
      return { url: canvas.toDataURL('image/png'), items };
    } finally {
      canvas.width = canvas.height = 0; // release memory promptly (iOS canvas budget)
    }
  };
  let out;
  try {
    out = await render(layer.count > 0);
  } catch {
    out = await render(false); // canvas tainted by an SVG image on old WebKit
  }
  const dataUrl = out.url;
  const claudeItems = out.items;

  const toPx = (b) => [
    (b[0] - rect[0]) * scale,
    (b[1] - rect[1]) * scale,
    (b[2] - rect[0]) * scale,
    (b[3] - rect[1]) * scale,
  ];
  const groups = [];
  fresh.sort((a, b) => (a.t0 || 0) - (b.t0 || 0));
  for (const s of fresh) {
    const t0 = s.mt && s.mt > (s.t1 || 0) ? s.mt : s.t0 || 0;
    const t1 = s.mt && s.mt > (s.t1 || 0) ? s.mt : s.t1 || t0;
    const g = groups[groups.length - 1];
    if (g && t0 - g.t1 < GROUP_GAP_MS) {
      g.t1 = Math.max(g.t1, t1);
      g.bbox = unionRect(g.bbox, s._bbox);
      g.colors.add(colorName(s.color));
      g.tools.add(s.tool);
      g.count++;
    } else {
      groups.push({ t0, t1, bbox: s._bbox.slice(), colors: new Set([colorName(s.color)]), tools: new Set([s.tool]), count: 1 });
    }
  }
  const ink = groups.map((g) => {
    const px = toPx(g.bbox);
    const visible = px[2] >= 0 && px[3] >= 0 && px[0] <= W && px[1] <= H;
    const c = [Math.max(0, px[0]), Math.max(0, px[1]), Math.min(W, px[2]), Math.min(H, px[3])].map((v) => Math.round(v));
    return {
      t0: g.t0,
      t1: g.t1,
      bbox: c,
      visible,
      color: [...g.colors].join('+'),
      tool: g.tools.size === 1 && g.tools.has('hl') ? 'highlighter' : 'pen',
      strokes: g.count,
    };
  });

  return {
    dataUrl,
    width: W,
    height: H,
    mode,
    world: { x: rect[0], y: rect[1], scale },
    view: board.viewRect(),
    ink,
    newStrokes: fresh.length,
    claudeItems,
  };
}

// speech: [{start, end, text}] in epoch ms; ink groups from buildSnapshot (epoch ms)
export function buildTimeline(snap, speech) {
  const evs = [];
  for (const s of speech) evs.push({ type: 'speech', t0: s.start, t1: s.end, text: s.text });
  for (const g of snap.ink) {
    evs.push({ type: 'ink', t0: g.t0, t1: g.t1, bbox: g.bbox, color: g.color, tool: g.tool, strokes: g.strokes, visible: g.visible });
  }
  const origin = evs.length ? Math.min(...evs.map((e) => e.t0)) : Date.now();
  const rel = (t) => Math.round(((t - origin) / 1000) * 10) / 10;
  const events = evs
    .map(({ t0, t1, ...rest }) => ({ ...rest, start: rel(t0), end: Math.max(rel(t0), rel(t1)) }))
    .sort((a, b) => a.start - b.start);
  const v = snap.view;
  return {
    version: 1,
    mode: snap.mode,
    width: snap.width,
    height: snap.height,
    world: { x: round1(snap.world.x), y: round1(snap.world.y), scale: Math.round(snap.world.scale * 10000) / 10000 },
    view: { x0: round1(v[0]), y0: round1(v[1]), x1: round1(v[2]), y1: round1(v[3]) },
    new_strokes: snap.newStrokes,
    claude_items: snap.claudeItems,
    origin_ts: origin,
    events,
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

export function makeThumb(dataUrl, max = 520) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL('image/jpeg', 0.85);
      c.width = c.height = 0;
      resolve(out);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
