// Infinite ink board: camera, input (Pencil / touch / mouse), tools, history, rendering.
//
// Rendering: committed strokes are cached as world-space Path2D objects and painted onto the
// `ink` canvas; the stroke in progress (plus lasso / eraser / move previews) is painted each
// animation frame on the `live` canvas.
//
// Smooth pans and pinches, however much is on the board: the ink canvas reaches past the
// screen by a margin, and while the camera moves only its CSS transform changes (the GPU slides
// and scales the drawn bitmap; nothing is redrawn). It's redrawn when the screen would leave
// the drawn area, when the zoom drifts too far for the bitmap to stay sharp, and once when the
// camera settles. The paper slides the same way, and the board gets a `moving` class so the
// Claude layer is composited (moved by the GPU) only while it moves and is crisp at rest.
import { getStroke } from './vendor/perfect-freehand/perfect-freehand.mjs';
import { HL_ALPHA, inkColor } from './palette.js';
import { clamp, easeInOutCubic, rectsIntersect, uid, unionRect } from './util.js';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 12;
export const PEN_SIZES = [2.0, 3.5, 6.2];
export const HL_SIZES = [12, 20, 32];
export const ERASER_SIZES = [9, 16, 28];

const PAN_SLOP = 7;
const TAP_MAX_MS = 380;
const LONG_PRESS_MS = 560;
const FINGER_STROKE_GRACE_MS = 260;
const HISTORY_LIMIT = 300;
const SETTLE_MS = 140;          // no camera change for this long = the board is at rest
const INK_MAX_PIXELS = 15e6;    // iPad Safari refuses canvases over 16.7 MP
const PAPER_OVERSCAN = 96;      // px the paper reaches past the screen (> the largest dot step)

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

function strokeOptions(s, last) {
  if (s.tool === 'hl') {
    return { size: s.size, thinning: 0, smoothing: 0.6, streamline: 0.45, simulatePressure: false, last,
      start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 } };
  }
  return { size: s.size, thinning: 0.62, smoothing: 0.55, streamline: 0.3, simulatePressure: !!s.sim, last,
    easing: (t) => t, start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 } };
}

function outlinePath(outline) {
  const path = new Path2D();
  const n = outline.length;
  if (n === 0) return path;
  if (n < 3) {
    const [x, y] = outline[0];
    path.arc(x, y, 0.5, 0, Math.PI * 2);
    return path;
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const m0 = mid(outline[0], outline[1]);
  path.moveTo(m0[0], m0[1]);
  for (let i = 1; i <= n; i++) {
    const p = outline[i % n];
    const q = outline[(i + 1) % n];
    const m = mid(p, q);
    path.quadraticCurveTo(p[0], p[1], m[0], m[1]);
  }
  path.closePath();
  return path;
}

function outlineBBox(outline, s) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const src = outline.length ? outline : s.pts;
  for (const p of src) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  if (!outline.length) {
    const r = s.size;
    x0 -= r; y0 -= r; x1 += r; y1 += r;
  }
  return [x0, y0, x1, y1];
}

export function prepareStroke(s) {
  const outline = s.pts.length ? getStroke(s.pts, strokeOptions(s, true)) : [];
  s._path = outlinePath(outline);
  s._bbox = outlineBBox(outline, s);
  return s;
}

// A cheap, slightly generous box from the points alone. A loaded board uses it until a stroke is
// first painted (prepareStroke builds the real outline then), so opening a big board is quick:
// strokes far off screen are never outlined until you go there.
function quickBBox(s) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of s.pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  const r = s.size * 0.75 + 1;
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}

function lazyStroke(s) {
  s._path = null;
  if (!s._bbox) s._bbox = quickBBox(s); // parseStroke already measured it
  return s;
}

export function paintStroke(ctx, s, theme, alpha = 1) {
  if (!s._path) prepareStroke(s);
  const hl = s.tool === 'hl';
  ctx.globalAlpha = alpha * (hl ? HL_ALPHA[theme] : 1);
  ctx.globalCompositeOperation = hl ? (theme === 'dark' ? 'screen' : 'multiply') : 'source-over';
  ctx.fillStyle = inkColor(s.color, theme, hl);
  ctx.fill(s._path);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function distToSegSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

function strokeHit(s, x, y, r) {
  const b = s._bbox;
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const tol = r + s.size * 0.55;
  const tol2 = tol * tol;
  const pts = s.pts;
  if (pts.length === 1) {
    const dx = pts[0][0] - x, dy = pts[0][1] - y;
    return dx * dx + dy * dy <= tol2;
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegSq(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= tol2) return true;
  }
  return false;
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function serializeStroke(s) {
  const o = { id: s.id, tool: s.tool, color: s.color, size: s.size, t0: s.t0, t1: s.t1, pts: s.pts.flat() };
  if (s.sim) o.sim = 1;
  if (s.mt) o.mt = s.mt;
  return o;
}

// One pass over the points: build them, check them, and measure the box (big boards load many
// thousands of strokes, so this is the hot loop of opening one).
function parseStroke(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.pts)) return null;
  const pts = [];
  const flat = o.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, p) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    pts.push([x, y, p == null ? 0.5 : +p]);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    return true;
  };
  if (Array.isArray(flat[0])) {
    for (const p of flat) if (Array.isArray(p) && p.length >= 2 && !add(+p[0], +p[1], p[2])) return null;
  } else {
    for (let i = 0; i + 1 < flat.length; i += 3) if (!add(+flat[i], +flat[i + 1], flat[i + 2])) return null;
  }
  if (!pts.length) return null;
  const size = Number.isFinite(+o.size) && +o.size > 0 ? +o.size : 3.5;
  const r = size * 0.75 + 1;
  return {
    id: typeof o.id === 'string' ? o.id : uid('s'),
    tool: o.tool === 'hl' ? 'hl' : 'pen',
    color: typeof o.color === 'string' ? o.color : 'ink',
    size,
    t0: +o.t0 || 0,
    t1: +o.t1 || +o.t0 || 0,
    mt: +o.mt || 0,
    sim: !!o.sim,
    pts,
    _path: null,
    _bbox: [x0 - r, y0 - r, x1 + r, y1 + r], // generous until the stroke is first drawn (lazyStroke)
  };
}

export class Board extends EventTarget {
  constructor({ root, paper, ink, live, selection, hover }) {
    super();
    this.root = root;
    this.paper = paper;
    this.inkCanvas = ink;
    this.liveCanvas = live;
    this.selEl = selection;
    this.selBox = selection.querySelector('.sel-box');
    this.selBar = selection.querySelector('.sel-actions');
    this.hoverEl = hover;
    this.inkCtx = ink.getContext('2d');
    this.liveCtx = live.getContext('2d');

    this.cam = { x: 0, y: 0, z: 1 };
    this.strokes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.tool = 'pen';
    this.color = { pen: 'ink', hl: 'yellow' };
    this.widthIdx = { pen: 1, hl: 1, eraser: 1 };
    this.theme = 'light';
    this.fingerDraw = false;
    this.penSeen = false;
    this.onLongPress = null; // (info) => boolean (handled)
    this.onDoubleTap = null; // (info) => boolean (handled): a finger double-tap (opens media cards)
    this._lastTap = null;
    // Cards (cards.js): { hit(sx, sy) -> part|null, begin(part, sx, sy) -> bool, move(sx, sy),
    // end(cancelled) -> moved, tap(info) -> bool, pen() }. A finger on the selected card moves or
    // resizes it; a tap selects; the Pencil lets go.
    this.cardHooks = null;

    this.touches = new Map();
    this.gesture = null;
    this.action = null;
    this.selection = null;
    this.spaceDown = false;
    this.dirty = { view: true, ink: true, live: true, cam: false };
    this.changed = new Set(); // ids of strokes added / changed / removed here since takeOps()
    this._dirtyRegion = null; // world rect of the ink bitmap to redraw (erase, undo, remote changes)
    this.inkCam = null;   // the camera the ink bitmap was drawn with
    this.inkM = 0;        // px the ink canvas reaches past each screen edge
    this.moving = false;  // the camera is moving (pan, pinch, animation)
    this._settleTimer = 0;
    this._paperStep = 0;
    this._selBarSize = null;
    this.raf = 0;
    this.anim = null;
    this._lastLive = false;
    this._hoverTimer = 0;
    this._lpTimer = 0;

    this._frame = this._frame.bind(this);
    this._bindInput();
    this.resize();
  }

  // ------------------------------------------------------------------ public state

  setTheme(theme) {
    this.theme = theme;
    this._applyBlend();
    this._invalidate('ink', 'live');
  }

  // Paper style: 'dots' | 'grid' | 'lines' | 'plain' (patterns live in app.css).
  setPaper(kind) {
    const k = ['dots', 'grid', 'lines', 'plain'].includes(kind) ? kind : 'dots';
    if (this.paper.dataset.paper === k) return;
    this.paper.dataset.paper = k;
    this._applyView();
  }

  setTool(tool) {
    if (!['pen', 'hl', 'eraser', 'lasso'].includes(tool) || tool === this.tool) return;
    if (this.action) this._endAction(null, true);
    this.tool = tool;
    if (tool !== 'lasso') this.clearSelection();
    this._applyBlend();
    this._emit('tool', { tool });
  }

  get activeColor() {
    return this.color[this.tool === 'hl' ? 'hl' : 'pen'];
  }

  get widthFamily() {
    return this.tool === 'hl' ? 'hl' : this.tool === 'eraser' ? 'eraser' : 'pen';
  }

  setColor(key) {
    if (this.selection && this.selection.ids.size) {
      const items = [];
      for (const s of this.strokes) {
        if (this.selection.ids.has(s.id) && s.color !== key) {
          items.push({ id: s.id, from: s.color, to: key });
          s.color = key;
          this.changed.add(s.id);
        }
      }
      if (items.length) {
        this._pushHistory({ type: 'recolor', items });
        this._invalidateRegion(this.selection.bbox);
        this._changed();
      }
      return;
    }
    if (this.tool === 'eraser' || this.tool === 'lasso') this.setTool('pen');
    this.color[this.tool === 'hl' ? 'hl' : 'pen'] = key;
    this._emit('tool', { tool: this.tool });
  }

  setWidth(idx) {
    this.widthIdx[this.widthFamily] = clamp(idx, 0, 2);
    this._emit('tool', { tool: this.tool });
  }

  cycleWidth() {
    this.setWidth((this.widthIdx[this.widthFamily] + 1) % 3);
  }

  setFingerDraw(on) {
    this.fingerDraw = !!on;
  }

  load(list) {
    this.strokes = [];
    for (const o of Array.isArray(list) ? list : []) {
      const s = parseStroke(o);
      if (s) this.strokes.push(lazyStroke(s));
    }
    this.undoStack = [];
    this.redoStack = [];
    this.changed.clear();
    this.clearSelection();
    this._invalidate('ink');
    this._emit('history');
    this._emit('change', { local: false });
  }

  serialize() {
    return this.strokes.map(serializeStroke);
  }

  // ---- undo / redo across a reload (the automatic update carries them over: app.js)
  exportHistory() {
    const enc = (op) => {
      if (op.type === 'add' || op.type === 'remove') {
        return { type: op.type, label: op.label, items: op.items.map((it) => ({ s: serializeStroke(it.s), index: it.index })) };
      }
      if (op.type === 'move') return { ...op, ids: [...op.ids] };
      if (op.type === 'recolor') return { type: 'recolor', items: op.items };
      return null;
    };
    return { undo: this.undoStack.map(enc).filter(Boolean), redo: this.redoStack.map(enc).filter(Boolean) };
  }

  importHistory(h) {
    if (!h || !Array.isArray(h.undo) || !Array.isArray(h.redo)) return;
    const byId = new Map(this.strokes.map((s) => [s.id, s]));
    const stroke = (o) => byId.get(o && o.id) || (() => { const s = parseStroke(o); return s ? lazyStroke(s) : null; })();
    const dec = (op) => {
      if (op.type === 'add' || op.type === 'remove') {
        const items = op.items.map((it) => ({ s: stroke(it.s), index: it.index })).filter((it) => it.s);
        return items.length ? { ...op, items } : null;
      }
      return op;
    };
    this.undoStack = h.undo.map(dec).filter(Boolean);
    this.redoStack = h.redo.map(dec).filter(Boolean);
    this._emit('history');
  }

  // ---- ink as changes (the server keeps the board as a log of these; see server.py)

  // What changed here since the last call: dels first, then puts in stack order, each put saying
  // which stroke it sits on top of, so the server keeps everyone's stacking order the same.
  takeOps() {
    if (!this.changed.size) return [];
    const pos = new Map();
    this.strokes.forEach((s, i) => pos.set(s.id, i));
    const dels = [], puts = [];
    for (const id of this.changed) {
      const i = pos.get(id);
      if (i === undefined) dels.push({ op: 'del', id });
      else puts.push(i);
    }
    puts.sort((a, b) => a - b);
    this.changed.clear();
    return dels.concat(puts.map((i) => ({
      op: 'put', s: serializeStroke(this.strokes[i]), after: i > 0 ? this.strokes[i - 1].id : null,
    })));
  }

  // Changes from another device (or replayed local ones after a reload): applied in place, not
  // undoable here, and only the touched area of the ink is redrawn.
  applyRemote(ops) {
    if (!Array.isArray(ops) || !ops.length) return;
    let out = this.strokes.slice();
    let index = new Map();
    out.forEach((s, i) => index.set(s.id, i));
    let dirty = null;
    const reindex = () => { index = new Map(); out.forEach((s, i) => { if (s) index.set(s.id, i); }); };
    for (const o of ops) {
      if (!o || typeof o !== 'object') continue;
      if (o.op === 'del') {
        const i = index.get(o.id);
        if (i === undefined) continue;
        dirty = unionRect(dirty, out[i]._bbox);
        out[i] = null;
        index.delete(o.id);
        if (this.selection) this.selection.ids.delete(o.id);
      } else if (o.op === 'put') {
        const s = parseStroke(o.s);
        if (!s) continue;
        lazyStroke(s);
        dirty = unionRect(dirty, s._bbox);
        const i = index.get(s.id);
        if (i !== undefined) {
          dirty = unionRect(dirty, out[i]._bbox);
          out[i] = s;
        } else if (!('after' in o)) {
          out.push(s);
          index.set(s.id, out.length - 1);
        } else {
          const j = o.after == null ? -1 : index.get(o.after);
          if (j === undefined || j === out.length - 1) {
            out.push(s);
            index.set(s.id, out.length - 1);
          } else {
            out.splice(j + 1, 0, s);
            reindex();
          }
        }
      }
    }
    this.strokes = out.filter(Boolean);
    if (this.selection) {
      if (!this.selection.ids.size) this.clearSelection();
      else { this.selection.bbox = this._bboxOf(this.selection.ids); this._updateSelectionEl(); }
    }
    if (dirty) this._invalidateRegion(dirty);
    this._emit('change', { local: false });
  }

  get busy() {
    return !!this.action || this.touches.size > 0;
  }

  strokesSince(ts) {
    return this.strokes.filter((s) => Math.max(s.t0 || 0, s.mt || 0) > ts);
  }

  contentBounds() {
    let r = null;
    for (const s of this.strokes) r = unionRect(r, s._bbox);
    return r;
  }

  viewRect() {
    const { x, y, z } = this.cam;
    return [-x / z, -y / z, (this.W - x) / z, (this.H - y) / z];
  }

  // ------------------------------------------------------------------ camera

  setCamera(x, y, z, { silent = false } = {}) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (x === this.cam.x && y === this.cam.y && z === this.cam.z) return;
    this.cam.x = x;
    this.cam.y = y;
    this.cam.z = z;
    this._invalidate('view', 'cam');
    this._markMoving();
    if (this.action) this._invalidate('live');
    if (!silent) this._emit('camera', { ...this.cam });
  }

  _markMoving() {
    if (!this.moving) {
      this.moving = true;
      this.root.classList.add('moving');
    }
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => this._settle(), SETTLE_MS);
  }

  // The camera came to rest: drop the GPU hints and redraw the ink sharp if the bitmap was
  // scaled (or is running out of margin for the next pan).
  _settle() {
    this._settleTimer = 0;
    this.moving = false;
    this.root.classList.remove('moving');
    const t = this._inkOffset();
    if (!t || Math.abs(t.k - 1) > 1e-6 || t.slack < this.inkM * 0.4) this._invalidate('ink');
    this._emit('settle', { ...this.cam });
  }

  zoomAt(sx, sy, z) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const wx = (sx - this.cam.x) / this.cam.z;
    const wy = (sy - this.cam.y) / this.cam.z;
    this.setCamera(sx - wx * z, sy - wy * z, z);
  }

  animateTo(target, ms = 320) {
    const from = { ...this.cam };
    const t0 = performance.now();
    const lz0 = Math.log(from.z), lz1 = Math.log(clamp(target.z, MIN_ZOOM, MAX_ZOOM));
    // interpolate the world point at screen centre so the motion feels anchored
    const cx = this.W / 2, cy = this.H / 2;
    const w0 = [(cx - from.x) / from.z, (cy - from.y) / from.z];
    const z1 = Math.exp(lz1);
    const w1 = [(cx - target.x) / z1, (cy - target.y) / z1];
    const anim = { cancelled: false };
    this.anim = anim;
    const step = (now) => {
      if (anim.cancelled) return;
      const t = clamp((now - t0) / ms, 0, 1);
      const e = easeInOutCubic(t);
      const z = Math.exp(lz0 + (lz1 - lz0) * e);
      const wx = w0[0] + (w1[0] - w0[0]) * e;
      const wy = w0[1] + (w1[1] - w0[1]) * e;
      this.setCamera(cx - wx * z, cy - wy * z, z);
      if (t < 1) requestAnimationFrame(step);
      else if (this.anim === anim) this.anim = null;
    };
    requestAnimationFrame(step);
  }

  cancelAnimation() {
    if (this.anim) this.anim.cancelled = true;
    this.anim = null;
  }

  cameraForRect(rect, pad = 80, maxZ = 2) {
    const insetR = this.rightInset || 0;
    const availW = Math.max(200, this.W - insetR - pad * 2);
    const availH = Math.max(200, this.H - pad * 2 - 90);
    const w = Math.max(1, rect[2] - rect[0]), h = Math.max(1, rect[3] - rect[1]);
    const z = clamp(Math.min(availW / w, availH / h, maxZ), MIN_ZOOM, MAX_ZOOM);
    const cx = (this.W - insetR) / 2, cy = (this.H - 60) / 2;
    return { x: cx - ((rect[0] + rect[2]) / 2) * z, y: cy - ((rect[1] + rect[3]) / 2) * z, z };
  }

  fitContent(extraRect = null) {
    const r = unionRect(this.contentBounds(), extraRect);
    if (!r) return this.resetZoom();
    this.animateTo(this.cameraForRect(r));
  }

  resetZoom() {
    this.cancelAnimation();
    const cx = this.W / 2, cy = this.H / 2;
    const wx = (cx - this.cam.x) / this.cam.z, wy = (cy - this.cam.y) / this.cam.z;
    this.animateTo({ x: cx - wx, y: cy - wy, z: 1 });
  }

  // ------------------------------------------------------------------ history

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo(viaGesture = false) {
    if (this.action) return;
    const op = this.undoStack.pop();
    if (!op) {
      if (viaGesture) this._emit('hud', { text: 'Nothing to undo' });
      return;
    }
    const area = this._applyOp(op, true);
    this.redoStack.push(op);
    this._emit('hud', { text: 'Undo', icon: 'undo' });
    this._afterHistory(area);
  }

  redo(viaGesture = false) {
    if (this.action) return;
    const op = this.redoStack.pop();
    if (!op) {
      if (viaGesture) this._emit('hud', { text: 'Nothing to redo' });
      return;
    }
    const area = this._applyOp(op, false);
    this.undoStack.push(op);
    this._emit('hud', { text: 'Redo', icon: 'redo' });
    this._afterHistory(area);
  }

  _afterHistory(area) {
    this.clearSelection();
    if (area) this._invalidateRegion(area);
    else this._invalidate('ink');
    this._emit('history');
    this._changed();
  }

  _pushHistory(op) {
    this.undoStack.push(op);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this._emit('history');
  }

  // Returns the world rect it touched (so only that part of the ink is redrawn).
  _applyOp(op, inverse) {
    let area = null;
    const touch = (s) => { area = unionRect(area, s._bbox); this.changed.add(s.id); };
    switch (op.type) {
      case 'add':
        if (inverse) {
          for (const it of this._removeIds(new Set(op.items.map((x) => x.s.id)))) area = unionRect(area, it.s._bbox);
        } else {
          for (const it of op.items) {
            this.strokes.splice(Math.min(it.index, this.strokes.length), 0, it.s);
            touch(it.s);
          }
        }
        break;
      case 'remove':
        if (inverse) {
          for (let i = op.items.length - 1; i >= 0; i--) {
            const it = op.items[i];
            this.strokes.splice(Math.min(it.index, this.strokes.length), 0, it.s);
            touch(it.s);
          }
        } else {
          for (const it of this._removeIds(new Set(op.items.map((x) => x.s.id)))) area = unionRect(area, it.s._bbox);
        }
        break;
      case 'move': {
        const k = inverse ? -1 : 1;
        area = this._translate(op.ids, op.dx * k, op.dy * k, false);
        const mts = new Map(op.prevMt || []);
        for (const s of this.strokes) {
          if (mts.has(s.id)) s.mt = inverse ? mts.get(s.id) : op.newMt;
        }
        break;
      }
      case 'recolor': {
        const map = new Map(op.items.map((it) => [it.id, inverse ? it.from : it.to]));
        for (const s of this.strokes) {
          if (map.has(s.id)) {
            s.color = map.get(s.id);
            touch(s);
          }
        }
        break;
      }
      default:
        break;
    }
    return area;
  }

  _removeIds(ids) {
    // one pass, keeping the order; returns items (old index ascending) usable for a 'remove' op
    const items = [];
    const kept = [];
    this.strokes.forEach((s, i) => {
      if (ids.has(s.id)) {
        items.push({ s, index: i });
        this.changed.add(s.id);
      } else kept.push(s);
    });
    if (items.length) this.strokes = kept;
    return items.reverse(); // descending, as before (undo re-inserts in reverse)
  }

  // Returns the world rect covering the strokes before and after the move.
  _translate(ids, dx, dy, markModified = true) {
    const set = ids instanceof Set ? ids : new Set(ids);
    const now = Date.now();
    let area = null;
    for (const s of this.strokes) {
      if (!set.has(s.id)) continue;
      area = unionRect(area, s._bbox);
      for (const p of s.pts) {
        p[0] = round2(p[0] + dx);
        p[1] = round2(p[1] + dy);
      }
      if (markModified) s.mt = now;
      prepareStroke(s);
      area = unionRect(area, s._bbox);
      this.changed.add(s.id);
    }
    return area;
  }

  clearBoard() {
    if (!this.strokes.length) return false;
    const items = this._removeIds(new Set(this.strokes.map((s) => s.id)));
    this._pushHistory({ type: 'remove', items, label: 'clear' });
    this.clearSelection();
    this._invalidate('ink');
    this._changed();
    return true;
  }

  // ------------------------------------------------------------------ selection

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this._selBarSize = null;
    this._updateSelectionEl();
    this._emit('selection', { count: 0 });
  }

  _setSelection(ids) {
    if (!ids.size) return this.clearSelection();
    this.selection = { ids, bbox: this._bboxOf(ids) };
    this._updateSelectionEl();
    this._emit('selection', { count: ids.size });
  }

  _bboxOf(ids) {
    let r = null;
    for (const s of this.strokes) if (ids.has(s.id)) r = unionRect(r, s._bbox);
    return r;
  }

  deleteSelection() {
    if (!this.selection) return;
    const area = this.selection.bbox;
    const items = this._removeIds(this.selection.ids);
    if (items.length) this._pushHistory({ type: 'remove', items });
    this.clearSelection();
    this._invalidateRegion(area);
    this._changed();
  }

  duplicateSelection() {
    if (!this.selection) return;
    const off = 24 / this.cam.z;
    const now = Date.now();
    const items = [];
    const ids = new Set();
    for (const s of this.strokes.slice()) {
      if (!this.selection.ids.has(s.id)) continue;
      const c = { ...s, id: uid('s'), t0: now, t1: now, mt: 0, pts: s.pts.map((p) => [round2(p[0] + off), round2(p[1] + off), p[2]]) };
      prepareStroke(c);
      this.strokes.push(c);
      this.changed.add(c.id);
      items.push({ s: c, index: this.strokes.length - 1 });
      ids.add(c.id);
    }
    if (items.length) this._pushHistory({ type: 'add', items });
    this._setSelection(ids);
    if (this.selection) this._invalidateRegion(this.selection.bbox);
    this._changed();
  }

  _inSelection(p) {
    if (!this.selection) return false;
    const b = this.selection.bbox;
    const pad = 14 / this.cam.z;
    return p.x >= b[0] - pad && p.x <= b[2] + pad && p.y >= b[1] - pad && p.y <= b[3] + pad;
  }

  _updateSelectionEl() {
    const sel = this.selection;
    if (!sel || !sel.bbox) {
      this.selEl.hidden = true;
      return;
    }
    const { x, y, z } = this.cam;
    const off = this.action && this.action.kind === 'move' ? this.action : { dx: 0, dy: 0 };
    const b = sel.bbox;
    const pad = 10;
    const left = (b[0] + off.dx) * z + x - pad;
    const top = (b[1] + off.dy) * z + y - pad;
    const w = (b[2] - b[0]) * z + pad * 2;
    const h = (b[3] - b[1]) * z + pad * 2;
    this.selEl.hidden = false;
    this.selBox.style.transform = `translate(${left}px, ${top}px)`;
    this.selBox.style.width = `${w}px`;
    this.selBox.style.height = `${h}px`;
    // measured once per selection: reading layout every frame of a pan would stall it
    if (!this._selBarSize) this._selBarSize = { w: this.selBar.offsetWidth || 110, h: this.selBar.offsetHeight || 48 };
    const barW = this._selBarSize.w;
    const barH = this._selBarSize.h;
    let bx = clamp(left + w / 2 - barW / 2, 8, this.W - barW - 8);
    let by = top - barH - 10;
    if (by < 60) by = Math.min(top + h + 10, this.H - barH - 100);
    this.selBar.style.transform = `translate(${bx}px, ${by}px)`;
    this.selBar.classList.toggle('moving', !!(this.action && this.action.kind === 'move'));
  }

  // ------------------------------------------------------------------ layout + render

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    if (w === this.W && h === this.H && dpr === this.dpr) return;
    if (this.W && this.H && (w !== this.W || h !== this.H)) {
      this.cam.x += (w - this.W) / 2;
      this.cam.y += (h - this.H) / 2;
      this._emit('camera', { ...this.cam });
    }
    this.W = w;
    this.H = h;
    this.dpr = dpr;
    // ink: the screen plus a margin M on every side (a quarter screen), kept under the pixel
    // limit: (w + 2M)(h + 2M)·dpr² <= INK_MAX_PIXELS
    const A = INK_MAX_PIXELS / (dpr * dpr);
    const disc = (w + h) * (w + h) - 4 * (w * h - A);
    const mFit = disc > 0 ? (-(w + h) + Math.sqrt(disc)) / 4 : 0;
    const M = Math.max(0, Math.floor(Math.min(0.25 * Math.max(w, h), mFit)));
    this.inkM = M;
    const ink = this.inkCanvas;
    ink.width = Math.round((w + 2 * M) * dpr);
    ink.height = Math.round((h + 2 * M) * dpr);
    ink.style.width = `${w + 2 * M}px`;
    ink.style.height = `${h + 2 * M}px`;
    ink.style.left = `${-M}px`;
    ink.style.top = `${-M}px`;
    ink.style.transform = '';
    this.inkCam = null;
    const live = this.liveCanvas;
    live.width = Math.round(w * dpr);
    live.height = Math.round(h * dpr);
    live.style.width = `${w}px`;
    live.style.height = `${h}px`;
    this._invalidate('view', 'ink', 'live');
  }

  _invalidate(...parts) {
    for (const p of parts) this.dirty[p] = true;
    if (!this.raf) this.raf = requestAnimationFrame(this._frame);
  }

  // Redraw just this world rect of the ink bitmap on the next frame (erasing, undo, a remote
  // change, the ends of a lasso move): the rest of the bitmap is untouched.
  _invalidateRegion(rect) {
    if (!rect) return;
    this._dirtyRegion = unionRect(this._dirtyRegion, rect);
    if (!this.raf) this.raf = requestAnimationFrame(this._frame);
  }

  _frame() {
    this.raf = 0;
    if (this.dirty.view) {
      this.dirty.view = false;
      this._applyView();
    }
    if (this.dirty.ink) {
      this.dirty.ink = false;
      this.dirty.cam = false;
      this._renderInk();
    } else if (this.dirty.cam) {
      this.dirty.cam = false;
      this._placeInk();
    }
    if (this._dirtyRegion) {
      const r = this._dirtyRegion;
      this._dirtyRegion = null;
      this._renderInkRegion(r);
    }
    if (this.dirty.live) {
      this.dirty.live = false;
      this._renderLive();
    }
  }

  _applyView() {
    const { x, y, z } = this.cam;
    let step = 24 * z;
    while (step < 15) step *= 2;
    while (step > 44) step /= 2;
    if (this.paper.dataset.paper === 'lines') step *= 2; // ruled paper: roomier rows
    // the paper reaches PAPER_OVERSCAN px past the screen; sliding it by less than one dot step
    // (a GPU transform) looks exactly like an endless pattern, with no repaint per frame
    if (step !== this._paperStep) {
      this._paperStep = step;
      this.paper.style.backgroundSize = `${step}px ${step}px`;
    }
    const d = this.dpr || 1;
    const P = PAPER_OVERSCAN;
    const tx = Math.round(((((x - step / 2 + P) % step) + step) % step) * d) / d;
    const ty = Math.round(((((y - step / 2 + P) % step) + step) % step) * d) / d;
    this.paper.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
    this._updateSelectionEl();
    this._emit('view', { ...this.cam });
  }

  _worldTransform(ctx, dx = 0, dy = 0) {
    const { x, y, z } = this.cam;
    const d = this.dpr;
    ctx.setTransform(d * z, 0, 0, d * z, d * (x + dx * z), d * (y + dy * z));
  }

  // world -> ink-bitmap pixels, for the camera the bitmap was drawn with
  _inkTransform(ctx) {
    const { x, y, z } = this.inkCam || this.cam;
    const d = this.dpr, M = this.inkM;
    ctx.setTransform(d * z, 0, 0, d * z, d * (x + M), d * (y + M));
  }

  _renderInk() {
    const ctx = this.inkCtx;
    const M = this.inkM;
    const { x, y, z } = this.cam;
    this.inkCam = { x, y, z };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.inkCanvas.width, this.inkCanvas.height);
    this._inkTransform(ctx);
    const m = 4 / z;
    const vis = [(-M - x) / z - m, (-M - y) / z - m, (this.W + M - x) / z + m, (this.H + M - y) / z + m];
    for (const s of this.strokes) {
      if (s._hidden || !rectsIntersect(s._bbox, vis)) continue;
      paintStroke(ctx, s, this.theme);
    }
    this.inkCanvas.style.transform = '';
    this._dirtyRegion = null; // everything was just drawn
  }

  // Redraw one world rect of the bitmap: clip to it (whole device pixels, a little padding),
  // clear it, and paint only the strokes that reach into it, in stacking order.
  _renderInkRegion(r) {
    if (!this.inkCam) {
      this._renderInk();
      return;
    }
    const { x, y, z } = this.inkCam;
    const d = this.dpr, M = this.inkM;
    const c = this.inkCanvas;
    const pad = 3 / z;
    const px0 = Math.max(0, Math.floor(((r[0] - pad) * z + x + M) * d));
    const py0 = Math.max(0, Math.floor(((r[1] - pad) * z + y + M) * d));
    const px1 = Math.min(c.width, Math.ceil(((r[2] + pad) * z + x + M) * d));
    const py1 = Math.min(c.height, Math.ceil(((r[3] + pad) * z + y + M) * d));
    if (px1 <= px0 || py1 <= py0) return; // off the drawn area: the next full draw covers it
    const ctx = this.inkCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(px0, py0, px1 - px0, py1 - py0);
    ctx.clip();
    ctx.clearRect(px0, py0, px1 - px0, py1 - py0);
    this._inkTransform(ctx);
    const area = [(px0 / d - M - x) / z, (py0 / d - M - y) / z, (px1 / d - M - x) / z, (py1 / d - M - y) / z];
    for (const s of this.strokes) {
      if (s._hidden || !rectsIntersect(s._bbox, area)) continue;
      paintStroke(ctx, s, this.theme);
    }
    ctx.restore();
  }

  // Where the drawn ink bitmap sits for the current camera: a scale k and offset (tx, ty) for
  // the canvas, and `slack`, how many px of drawn ink reach past the nearest screen edge.
  _inkOffset() {
    const r = this.inkCam;
    if (!r) return null;
    const c = this.cam, M = this.inkM, k = c.z / r.z;
    let tx = M - k * (M + r.x) + c.x;
    let ty = M - k * (M + r.y) + c.y;
    if (Math.abs(k - 1) < 1e-6) {
      // a pure pan: whole device pixels keep the bitmap exactly as sharp as a redraw
      const d = this.dpr;
      tx = Math.round(tx * d) / d;
      ty = Math.round(ty * d) / d;
    }
    const left = -M + tx, top = -M + ty;
    const right = left + k * (this.W + 2 * M), bottom = top + k * (this.H + 2 * M);
    const slack = Math.min(-left, -top, right - this.W, bottom - this.H);
    return { k, tx, ty, slack };
  }

  // The camera moved but the ink didn't: slide / scale the bitmap instead of redrawing it.
  _placeInk() {
    const t = this._inkOffset();
    if (!t || t.slack < -0.5 || t.k > 2 || t.k < 0.5) {
      this._renderInk();
      return;
    }
    const still = Math.abs(t.k - 1) < 1e-6 && t.tx === 0 && t.ty === 0;
    this.inkCanvas.style.transform = still ? '' : `translate(${t.tx}px, ${t.ty}px) scale(${t.k})`;
  }

  _renderLive() {
    const ctx = this.liveCtx;
    const a = this.action;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    if (!a) return;
    if (a.kind === 'stroke') {
      const s = a.s;
      const pts = a.predicted && a.predicted.length ? s.pts.concat(a.predicted) : s.pts;
      if (!pts.length) return;
      const outline = getStroke(pts, strokeOptions(s, false));
      const hl = s.tool === 'hl';
      this._worldTransform(ctx);
      ctx.globalAlpha = hl ? HL_ALPHA[this.theme] : 1;
      ctx.fillStyle = inkColor(s.color, this.theme, hl);
      ctx.fill(outlinePath(outline));
      ctx.globalAlpha = 1;
    } else if (a.kind === 'erase') {
      const r = ERASER_SIZES[this.widthIdx.eraser];
      const sx = a.pos.x * this.cam.z + this.cam.x, sy = a.pos.y * this.cam.z + this.cam.y;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = this.theme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)';
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = this.theme === 'dark' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.35)';
      ctx.stroke();
    } else if (a.kind === 'lasso') {
      if (a.pts.length < 2) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.beginPath();
      a.pts.forEach((p, i) => {
        const sx = p[0] * this.cam.z + this.cam.x, sy = p[1] * this.cam.z + this.cam.y;
        if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(10, 132, 255, 0.07)';
      ctx.fill();
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = -((performance.now() / 40) % 10);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(10, 132, 255, 0.9)';
      ctx.stroke();
      ctx.setLineDash([]);
      this._invalidate('live'); // marching ants
    } else if (a.kind === 'move') {
      const pic = a.picture;
      if (pic && pic.z === this.cam.z) {
        const d = this.dpr;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(pic.canvas, Math.round((((pic.b[0] + a.dx) * this.cam.z + this.cam.x) - pic.pad) * d),
          Math.round((((pic.b[1] + a.dy) * this.cam.z + this.cam.y) - pic.pad) * d));
      } else {
        this._worldTransform(ctx, a.dx, a.dy);
        for (const s of this.strokes) if (s._hidden) paintStroke(ctx, s, this.theme);
      }
    }
  }

  _applyBlend() {
    const hl = this.tool === 'hl';
    this.liveCanvas.style.mixBlendMode = hl ? (this.theme === 'dark' ? 'screen' : 'multiply') : 'normal';
  }

  // ------------------------------------------------------------------ input

  _bindInput() {
    const el = this.root;
    el.addEventListener('pointerdown', (e) => this._onDown(e));
    el.addEventListener('pointermove', (e) => this._onMove(e));
    el.addEventListener('pointerup', (e) => this._onUp(e, false));
    el.addEventListener('pointercancel', (e) => this._onUp(e, true));
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch') this._hideHover();
    });
    el.addEventListener('lostpointercapture', (e) => {
      if (this.action && this.action.id === e.pointerId) this._endAction(e, false);
    });
    el.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS: stop the long-press loupe / selection / double-tap zoom on the board itself
    const stop = (e) => { if (e.cancelable) e.preventDefault(); };
    el.addEventListener('touchstart', stop, { passive: false });
    el.addEventListener('touchmove', stop, { passive: false });
    el.addEventListener('touchend', stop, { passive: false });
    el.addEventListener('dblclick', stop);
    // macOS Safari trackpad pinch
    let gz = 1;
    el.addEventListener('gesturestart', (e) => { e.preventDefault(); gz = this.cam.z; });
    el.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (this.touches.size) return; // iOS: pointer events already handle pinch
      this.zoomAt(e.clientX, e.clientY, gz * e.scale);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !isTyping(e)) { this.spaceDown = true; }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
    window.addEventListener('blur', () => { this.spaceDown = false; });
  }

  _pt(e) {
    return { x: (e.clientX - this.cam.x) / this.cam.z, y: (e.clientY - this.cam.y) / this.cam.z };
  }

  _capture(e) {
    try { this.root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  _onDown(e) {
    this.cancelAnimation();
    const ae = document.activeElement;
    if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur(); // dismiss the iPad keyboard
    if (e.pointerType === 'touch') {
      this._touchDown(e);
      return;
    }
    if (e.pointerType === 'pen') this._penDetected();
    if (e.pointerType === 'mouse') {
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        e.preventDefault();
        this._capture(e);
        this.action = { kind: 'pan', id: e.pointerId, type: 'mouse', sx: e.clientX, sy: e.clientY, cam0: { ...this.cam } };
        return;
      }
      if (e.button !== 0) return;
      // the mouse can move / resize a selected card too (handy on the PC)
      const part = this.cardHooks && !this.action ? this.cardHooks.hit(e.clientX, e.clientY) : null;
      const use = !part && this.cardHooks && !this.action ? this.cardHooks.useAt(e.clientX, e.clientY) : null;
      if ((part && this.cardHooks.begin(part, e.clientX, e.clientY))
          || (use && use.part === 'bar' && this.cardHooks.grabBar(use.id, e.clientX, e.clientY))) {
        this._capture(e);
        this.action = { kind: 'card', id: e.pointerId, type: 'mouse' };
        return;
      }
      if (use && use.part === 'content') { // the mouse uses live cards too (handy on the PC)
        this._capture(e);
        this.cardHooks.useStart(use, e.clientX, e.clientY);
        this.action = { kind: 'use', id: e.pointerId, type: 'mouse' };
        return;
      }
    }
    if (e.pointerType === 'pen' && this.cardHooks) this.cardHooks.pen();
    if (this.action) {
      // a pen always wins over a finger action
      if (e.pointerType === 'pen' && this.action.type === 'touch') this._endAction(null, this.action.kind === 'stroke');
      else return;
    }
    if (this.gesture) this._suspendGesture();
    this._hideHover();
    this._capture(e);
    this._startAction(e, e.pointerType);
  }

  _penDetected() {
    if (this.penSeen) return;
    this.penSeen = true;
    if (this.fingerDraw) {
      this.fingerDraw = false;
      this._emit('fingerdraw', { on: false, reason: 'pencil' });
    }
  }

  _startAction(e, type) {
    const p = this._pt(e);
    if (this.selection && this._inSelection(p)) {
      this._beginMove(e, p, type);
      return;
    }
    if (this.selection) this.clearSelection();
    if (this.tool === 'pen' || this.tool === 'hl') this._beginStroke(e, type);
    else if (this.tool === 'eraser') this._beginErase(e, p, type);
    else if (this.tool === 'lasso') this._beginLasso(e, p, type);
  }

  _onMove(e) {
    const a = this.action;
    if (e.pointerType === 'touch') {
      this._touchMove(e);
      return;
    }
    if (a && a.id === e.pointerId) {
      this._moveAction(e);
      return;
    }
    if (!a && (e.pointerType === 'pen' || e.pointerType === 'mouse') && e.buttons === 0) this._showHover(e);
  }

  _onUp(e, cancelled) {
    if (e.pointerType === 'touch') {
      this._touchUp(e, cancelled);
      return;
    }
    const a = this.action;
    if (a && a.id === e.pointerId) this._endAction(e, false);
  }

  _moveAction(e) {
    const a = this.action;
    if (a.kind === 'pan') {
      this.setCamera(a.cam0.x + e.clientX - a.sx, a.cam0.y + e.clientY - a.sy, this.cam.z);
      return;
    }
    if (a.kind === 'card') {
      this.cardHooks.move(e.clientX, e.clientY);
      return;
    }
    if (a.kind === 'use') {
      this.cardHooks.useMove(e.clientX, e.clientY);
      return;
    }
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const list = events && events.length ? events : [e];
    if (a.kind === 'stroke') {
      for (const ce of list) this._addPoint(a.s, ce);
      const pred = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : null;
      if (pred && pred.length) {
        const last = a.s.pts[a.s.pts.length - 1];
        a.predicted = pred.slice(0, 2).map((pe) => {
          const q = this._pt(pe);
          return [q.x, q.y, last ? last[2] : 0.5];
        });
      } else a.predicted = null;
      this._invalidate('live');
    } else if (a.kind === 'erase') {
      for (const ce of list) {
        const p = this._pt(ce);
        this._eraseAlong(a, a.pos, p);
        a.pos = p;
      }
      this._invalidate('live');
    } else if (a.kind === 'lasso') {
      const p = this._pt(e);
      const last = a.pts[a.pts.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) * this.cam.z > 2) a.pts.push([p.x, p.y]);
      this._invalidate('live');
    } else if (a.kind === 'move') {
      const p = this._pt(e);
      a.dx = p.x - a.start.x;
      a.dy = p.y - a.start.y;
      this._updateSelectionEl();
      this._invalidate('live');
    }
    if (a.type === 'touch' && this._lpTimer) {
      const t = this.touches.get(e.pointerId);
      if (t && Math.hypot(t.x - t.sx, t.y - t.sy) > PAN_SLOP) this._cancelLongPress();
    }
  }

  _endAction(e, discard) {
    const a = this.action;
    if (!a) return;
    this.action = null;
    if (a.kind === 'stroke') {
      if (!discard && a.s.pts.length) {
        a.s.t1 = Date.now();
        this._commitStroke(a.s);
      }
    } else if (a.kind === 'erase') {
      if (a.removed.length) {
        this._pushHistory({ type: 'remove', items: a.removed });
        this._changed();
      }
    } else if (a.kind === 'lasso') {
      if (!discard) this._finishLasso(a);
    } else if (a.kind === 'card') {
      this.cardHooks.end(!!discard);
    } else if (a.kind === 'use') {
      if (discard || !e) this.cardHooks.useCancel();
      else this.cardHooks.useEnd(e.clientX, e.clientY);
    } else if (a.kind === 'move') {
      const ids = this.selection ? this.selection.ids : new Set();
      let area = this.selection ? this.selection.bbox : null; // where they were lifted from
      for (const s of this.strokes) s._hidden = false;
      if (!discard && (Math.abs(a.dx) > 0.01 || Math.abs(a.dy) > 0.01) && ids.size) {
        const prevMt = this.strokes.filter((s) => ids.has(s.id)).map((s) => [s.id, s.mt || 0]);
        area = unionRect(area, this._translate(ids, a.dx, a.dy, true));
        const moved = this.strokes.find((s) => ids.has(s.id));
        this._pushHistory({ type: 'move', ids: [...ids], dx: a.dx, dy: a.dy, prevMt, newMt: moved ? moved.mt : Date.now() });
        this.selection.bbox = this._bboxOf(ids);
        this._changed();
      }
      this._updateSelectionEl();
      if (area) this._invalidateRegion(area);
      else this._invalidate('ink');
    }
    // clear the live layer in the same task as the ink commit -> no double-draw flash
    const ctx = this.liveCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
  }

  // ---- stroke
  _beginStroke(e, type) {
    const tool = this.tool;
    const screenSize = tool === 'hl' ? HL_SIZES[this.widthIdx.hl] : PEN_SIZES[this.widthIdx.pen];
    const s = {
      id: uid('s'),
      tool,
      color: this.color[tool === 'hl' ? 'hl' : 'pen'],
      size: round3(screenSize / this.cam.z),
      t0: Date.now(),
      t1: 0,
      mt: 0,
      sim: type !== 'pen',
      pts: [],
    };
    this.action = { kind: 'stroke', id: e.pointerId, type, s, t: performance.now(), predicted: null };
    this._addPoint(s, e);
    this._invalidate('live');
  }

  _addPoint(s, ev) {
    const x = (ev.clientX - this.cam.x) / this.cam.z;
    const y = (ev.clientY - this.cam.y) / this.cam.z;
    let pr = 0.5;
    if (!s.sim) {
      const raw = ev.pressure;
      pr = raw > 0 ? Math.pow(Math.min(raw, 1), 0.78) : s.pts.length ? s.pts[s.pts.length - 1][2] : 0.35;
      pr = clamp(pr, 0.06, 1);
    }
    const last = s.pts[s.pts.length - 1];
    if (last) {
      const dx = (x - last[0]) * this.cam.z, dy = (y - last[1]) * this.cam.z;
      if (dx * dx + dy * dy < 0.25) {
        if (!s.sim) last[2] = round3(Math.max(last[2], pr));
        return;
      }
    }
    s.pts.push([round2(x), round2(y), round3(pr)]);
  }

  _commitStroke(s) {
    prepareStroke(s);
    this.strokes.push(s);
    this.changed.add(s.id);
    this._pushHistory({ type: 'add', items: [{ s, index: this.strokes.length - 1 }] });
    if (!this.dirty.ink && this.inkCam) {
      // incremental paint on top of the cached bitmap (in the bitmap's own camera)
      this._inkTransform(this.inkCtx);
      paintStroke(this.inkCtx, s, this.theme);
    }
    this._changed();
  }

  // ---- eraser
  _beginErase(e, p, type) {
    this.action = { kind: 'erase', id: e.pointerId, type, removed: [], pos: p };
    this._eraseAlong(this.action, p, p);
    this._invalidate('live');
  }

  _eraseAlong(a, from, to) {
    const r = ERASER_SIZES[this.widthIdx.eraser] / this.cam.z;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / (r * 0.5)));
    // only strokes whose box reaches the eraser's path can be hit
    const path = [Math.min(from.x, to.x) - r, Math.min(from.y, to.y) - r, Math.max(from.x, to.x) + r, Math.max(from.y, to.y) + r];
    let area = null;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (!rectsIntersect(s._bbox, path)) continue;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        if (strokeHit(s, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, r)) {
          a.removed.push({ s, index: i });
          this.strokes.splice(i, 1);
          this.changed.add(s.id);
          area = unionRect(area, s._bbox);
          break;
        }
      }
    }
    if (area) this._invalidateRegion(area); // just where the erased strokes were
  }

  // ---- lasso
  _beginLasso(e, p, type) {
    this.action = { kind: 'lasso', id: e.pointerId, type, pts: [[p.x, p.y]] };
    this._invalidate('live');
  }

  _finishLasso(a) {
    const poly = a.pts;
    let len = 0;
    for (let i = 1; i < poly.length; i++) len += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
    const ids = new Set();
    if (len * this.cam.z < 12) {
      // a tap: select the top-most stroke under the point
      const [x, y] = poly[0];
      for (let i = this.strokes.length - 1; i >= 0; i--) {
        if (strokeHit(this.strokes[i], x, y, 6 / this.cam.z)) {
          ids.add(this.strokes[i].id);
          break;
        }
      }
    } else {
      let pb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of poly) pb = [Math.min(pb[0], p[0]), Math.min(pb[1], p[1]), Math.max(pb[2], p[0]), Math.max(pb[3], p[1])];
      for (const s of this.strokes) {
        if (!rectsIntersect(s._bbox, pb)) continue;
        const pts = s.pts;
        const step = Math.max(1, Math.floor(pts.length / 24));
        let inside = 0, total = 0;
        for (let i = 0; i < pts.length; i += step) {
          total++;
          if (pointInPoly(pts[i][0], pts[i][1], poly)) inside++;
        }
        if (total && inside / total >= 0.5) ids.add(s.id);
      }
    }
    this._setSelection(ids);
  }

  // ---- move selection
  _beginMove(e, p, type) {
    this.action = { kind: 'move', id: e.pointerId, type, start: p, dx: 0, dy: 0, picture: this._pictureOfSelection() };
    for (const s of this.strokes) s._hidden = this.selection.ids.has(s.id);
    this._invalidateRegion(this.selection.bbox); // lift them off the ink
    this._invalidate('live');
    this._updateSelectionEl();
  }

  // The selected strokes drawn once into their own canvas, which then slides with the finger
  // (rather than re-drawing every stroke on every frame). Null if it would be huge.
  _pictureOfSelection() {
    const b = this.selection && this.selection.bbox;
    if (!b) return null;
    const z = this.cam.z, d = this.dpr, pad = 4;
    const w = Math.ceil(((b[2] - b[0]) * z + pad * 2) * d);
    const h = Math.ceil(((b[3] - b[1]) * z + pad * 2) * d);
    if (w <= 0 || h <= 0 || w * h > 8e6) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.setTransform(z * d, 0, 0, z * d, (pad - b[0] * z) * d, (pad - b[1] * z) * d);
    for (const s of this.strokes) if (this.selection.ids.has(s.id)) paintStroke(ctx, s, this.theme);
    return { canvas: c, b, z, pad };
  }

  // ---- touch: pan / pinch / taps / long-press / optional finger drawing
  _touchDown(e) {
    if (this.action && this.action.type === 'pen') return; // palm while the Pencil is down
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    this._capture(e);
    const n = this.touches.size;
    if (n === 1) {
      this.gesture = { t0: performance.now(), max: 1, moved: false, owner: null, suspended: false, camStart: { ...this.cam } };
      const p = this._pt(e);
      // a finger on the selected card (or one of its corners) arranges it
      const part = this.cardHooks && !this.action ? this.cardHooks.hit(e.clientX, e.clientY) : null;
      const use = !part && this.cardHooks && !this.action && !this.fingerDraw ? this.cardHooks.useAt(e.clientX, e.clientY) : null;
      if (part && this.cardHooks.begin(part, e.clientX, e.clientY)) {
        this.gesture.owner = 'card';
        this.gesture.cardPointer = e.pointerId;
      } else if (use && use.part === 'bar' && this.cardHooks.grabBar(use.id, e.clientX, e.clientY)) {
        this.gesture.owner = 'card'; // a live card's title strip: arranging, like a window's
        this.gesture.cardPointer = e.pointerId;
      } else if (this.fingerDraw && !this.action) {
        this._startAction(e, 'touch');
        this.gesture.owner = 'action';
      } else if (this.selection && this._inSelection(p) && !this.action) {
        this._beginMove(e, p, 'touch');
        this.gesture.owner = 'action';
      } else if (use && use.part === 'content') {
        this.cardHooks.useStart(use, e.clientX, e.clientY); // a finger on a live card: using it
        this.gesture.owner = 'use';
        this.gesture.cardPointer = e.pointerId;
      }
      if (this.gesture.owner !== 'card' && !(e.width > 60 || e.height > 60)) this._startLongPress(e); // large contact = palm
    } else {
      const g = this.gesture;
      if (!g) return;
      this._cancelLongPress();
      if (g.owner === 'card') {
        // a second finger: keep the card where it is now and let two fingers move the board
        this.cardHooks.end(false);
        g.owner = null;
      } else if (g.owner === 'use') {
        this.cardHooks.useCancel(); // two fingers move the board, wherever they are
        g.owner = null;
      }
      if (this.action && this.action.type === 'touch') {
        const a = this.action;
        const young = performance.now() - (a.t || 0) < FINGER_STROKE_GRACE_MS;
        const discard = a.kind === 'stroke' ? young || a.s.pts.length < 6 : a.kind === 'lasso';
        this._endAction(null, discard);
        if (discard) g.owner = null;
      }
      g.max = Math.max(g.max, n);
    }
    this._rebaseGesture();
  }

  _rebaseGesture() {
    const g = this.gesture;
    if (!g) return;
    const pts = [...this.touches.values()];
    if (!pts.length) return;
    const c = pts.reduce((acc, p) => ({ x: acc.x + p.x / pts.length, y: acc.y + p.y / pts.length }), { x: 0, y: 0 });
    g.c0 = c;
    g.d0 = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    g.cam0 = { ...this.cam };
  }

  _touchMove(e) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX;
    t.y = e.clientY;
    if (this.action && this.action.id === e.pointerId) {
      this._moveAction(e);
      return;
    }
    const g = this.gesture;
    if (g && (g.owner === 'card' || g.owner === 'use')) {
      if (e.pointerId === g.cardPointer) {
        if (g.owner === 'card') this.cardHooks.move(e.clientX, e.clientY);
        else this.cardHooks.useMove(e.clientX, e.clientY);
        if (!g.moved && Math.hypot(t.x - t.sx, t.y - t.sy) > PAN_SLOP) {
          g.moved = true;
          this._cancelLongPress();
        }
      }
      return;
    }
    if (!g || g.suspended || (g.owner && this.touches.size < 2)) return;
    const pts = [...this.touches.values()];
    if (!g.moved) {
      let maxMove = 0;
      for (const p of pts) maxMove = Math.max(maxMove, Math.hypot(p.x - p.sx, p.y - p.sy));
      if (maxMove < PAN_SLOP) return;
      g.moved = true;
      this._cancelLongPress();
      this._rebaseGesture();
      return;
    }
    const c = pts.reduce((acc, p) => ({ x: acc.x + p.x / pts.length, y: acc.y + p.y / pts.length }), { x: 0, y: 0 });
    let z = g.cam0.z;
    if (pts.length >= 2 && g.d0 > 0) {
      z = clamp(g.cam0.z * (Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / g.d0), MIN_ZOOM, MAX_ZOOM);
    }
    const wx = (g.c0.x - g.cam0.x) / g.cam0.z;
    const wy = (g.c0.y - g.cam0.y) / g.cam0.z;
    this.setCamera(c.x - wx * z, c.y - wy * z, z);
  }

  _touchUp(e, cancelled) {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    if (this.action && this.action.id === e.pointerId) this._endAction(e, false);
    this._cancelLongPress();
    const g = this.gesture;
    if (g && g.owner === 'card' && e.pointerId === g.cardPointer) {
      // a press on the selected card that never moved is still a tap (a double-tap opens it)
      if (!this.cardHooks.end(!!cancelled)) g.owner = null;
    } else if (g && g.owner === 'use' && e.pointerId === g.cardPointer) {
      if (cancelled) this.cardHooks.useCancel();
      else this.cardHooks.useEnd(e.clientX, e.clientY); // taps and double-taps are the card's own
    }
    if (this.touches.size === 0) {
      if (g && !cancelled && !g.moved && !g.suspended && !g.owner) {
        const dt = performance.now() - g.t0;
        if (dt < TAP_MAX_MS) {
          if (g.max === 2) this.undo(true);
          else if (g.max === 3) this.redo(true);
          else if (g.max === 1) {
            if (this.selection) this.clearSelection();
            const now = performance.now(), x = e.clientX, y = e.clientY;
            const info = { x, y, wx: (x - this.cam.x) / this.cam.z, wy: (y - this.cam.y) / this.cam.z };
            if (this.cardHooks) this.cardHooks.tap(info); // select the card under the tap, or let go
            const prev = this._lastTap;
            if (prev && now - prev.t < 340 && Math.hypot(x - prev.x, y - prev.y) < 40 && this.onDoubleTap) {
              this._lastTap = null;
              this.onDoubleTap(info);
            } else {
              this._lastTap = { t: now, x, y };
            }
          }
        }
      }
      this.gesture = null;
    } else if (g) {
      this._rebaseGesture();
    }
  }

  _suspendGesture() {
    // the Pencil touched down while fingers/palm were on the glass: freeze the gesture and
    // undo a pan that started a moment ago (likely a palm landing just before the tip)
    const g = this.gesture;
    if (!g) return;
    g.suspended = true;
    this._cancelLongPress();
    if (g.owner === 'card') {
      // most likely a palm on a selected card as the Pencil lands: put the card back
      this.cardHooks.end(true);
      g.owner = null;
    } else if (g.owner === 'use') {
      this.cardHooks.useCancel(); // a palm on a live card as the Pencil lands
      g.owner = null;
    }
    if (g.moved && performance.now() - g.t0 < 450) {
      this.setCamera(g.camStart.x, g.camStart.y, g.camStart.z);
    }
  }

  _startLongPress(e) {
    this._cancelLongPress();
    const x = e.clientX, y = e.clientY;
    this._lpTimer = setTimeout(() => {
      this._lpTimer = 0;
      const g = this.gesture;
      if (!g || g.moved || g.suspended || this.touches.size !== 1 || !this.onLongPress) return;
      const handled = this.onLongPress({ x, y, wx: (x - this.cam.x) / this.cam.z, wy: (y - this.cam.y) / this.cam.z });
      if (handled) {
        if (this.action && this.action.type === 'touch') this._endAction(null, true);
        if (g.owner === 'use') this.cardHooks.useCancel(); // a long-press arranges, even on live content
        g.owner = 'longpress';
        // a long-press on a card selects it and picks it up: keep moving to drag it
        if (handled === 'card' && this.cardHooks && this.touches.size === 1) {
          const [pid, t] = [...this.touches.entries()][0];
          if (this.cardHooks.begin('body', t.x, t.y)) {
            g.owner = 'card';
            g.cardPointer = pid;
          }
        }
      }
    }, LONG_PRESS_MS);
  }

  _cancelLongPress() {
    if (this._lpTimer) clearTimeout(this._lpTimer);
    this._lpTimer = 0;
  }

  _onWheel(e) {
    e.preventDefault();
    this.cancelAnimation();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.H : 1;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * k * 0.0028);
      this.zoomAt(e.clientX, e.clientY, this.cam.z * factor);
    } else {
      this.setCamera(this.cam.x - e.deltaX * k, this.cam.y - e.deltaY * k, this.cam.z);
    }
  }

  // ---- hover preview (Apple Pencil hover / mouse)
  _showHover(e) {
    const el = this.hoverEl;
    let d;
    if (this.tool === 'eraser') d = ERASER_SIZES[this.widthIdx.eraser] * 2;
    else if (this.tool === 'hl') d = HL_SIZES[this.widthIdx.hl];
    else if (this.tool === 'pen') d = Math.max(4, PEN_SIZES[this.widthIdx.pen] * 1.15);
    else d = 6;
    el.style.width = el.style.height = `${d}px`;
    el.style.transform = `translate(${e.clientX - d / 2}px, ${e.clientY - d / 2}px)`;
    el.dataset.tool = this.tool;
    el.style.setProperty('--hover-color', this.tool === 'pen' || this.tool === 'hl' ? inkColor(this.activeColor, this.theme, this.tool === 'hl') : 'currentColor');
    el.classList.add('on');
    clearTimeout(this._hoverTimer);
    this._hoverTimer = setTimeout(() => this._hideHover(), e.pointerType === 'pen' ? 900 : 4000);
  }

  _hideHover() {
    clearTimeout(this._hoverTimer);
    this.hoverEl.classList.remove('on');
  }

  // ------------------------------------------------------------------ events

  _changed() {
    this._emit('change', { local: true });
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable);
}
