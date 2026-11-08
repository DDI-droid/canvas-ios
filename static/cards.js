// Arranging cards on the board. One set of rules for every kind of card (images and Claude's
// drawings today; video, live pages and 3D next): a selected card is being arranged, an
// unselected one is being used.
//
//   tap a card            -> select it: an outline, a handle on each corner, Open · Remove
//   drag a selected card  -> it lifts and follows your finger
//   drag a corner handle  -> resize; proportions kept, the opposite corner stays put
//   tap the empty board   -> let go
//   long-press a card     -> select it and pick it up in one go
//
// The Pencil never moves or resizes cards: it draws, and putting it down lets go. Two fingers
// always zoom and pan the board. The overlay is purely visual (pointer-events: none) and the
// board routes touches here (Board.cardHooks), so nothing else about touch input changes.
//
// While a card moves, only its CSS transform changes (GPU work, no re-layout); the new place
// and size are committed when you let go, then saved to the server, which tells every page.
import { clamp } from './util.js';

const DRAG_SLOP = 7;      // px before a press on a selected card becomes a move (same as panning)
const HANDLE_HIT = 24;    // px around a corner that grabs its handle (a ~48 px target)
const MIN_SIDE = 48;      // px on screen: a resize won't make the short side smaller than this
const MAX_WORLD = 20000;  // world units: the largest side a card can grow to
const round2 = (v) => Math.round(v * 100) / 100;

export class Cards {
  constructor({ board, layer, el, onCommit, onOpen, onRemove }) {
    this.board = board;
    this.layer = layer;
    this.el = el;
    this.box = el.querySelector('.card-box');
    this.bar = el.querySelector('.card-actions');
    this.openBtn = el.querySelector('[data-card="open"]');
    this.onCommit = onCommit;
    this.id = null;
    this.drag = null;
    this._bar = null; // cached pill size
    el.querySelector('[data-card="open"]').addEventListener('click', () => {
      const id = this.id;
      this.clear();
      if (id) onOpen(id);
    });
    el.querySelector('[data-card="remove"]').addEventListener('click', () => {
      const id = this.id;
      this.clear();
      if (id) onRemove(id);
    });
    // the card changed under us (moved from another device, removed, layer hidden, new session)
    layer.addEventListener('change', () => { if (this.id && !this.drag) this.sync(); });
  }

  get selected() { return this.id; }

  // a finger tap on the board: select the card under it, or let go of the current one
  tap({ wx, wy }) {
    const id = this.layer.hitTest(wx, wy, 6 / this.board.cam.z);
    if (id) this.select(id);
    else this.clear();
    return !!id;
  }

  // the Pencil touched down: it's drawing time
  pen() {
    this.clear();
  }

  select(id) {
    const rec = this.layer.records.get(id);
    if (!rec || !this.layer.visible) return this.clear();
    if (this.id !== id) {
      this.id = id;
      this.el.hidden = false;
      // replay the pill's pop-in for each new selection
      this.bar.style.animation = 'none';
      void this.bar.offsetWidth;
      this.bar.style.animation = '';
    }
    this.openBtn.hidden = rec.kind !== 'image';
    this._bar = null;
    this.sync();
  }

  clear() {
    if (this.drag) this.end(true);
    if (!this.id) return;
    this.id = null;
    this.el.hidden = true;
    this.el.classList.remove('moving', 'resizing');
  }

  // ---- geometry
  _rect(rec) {
    return this.drag && this.drag.rec === rec ? this.drag.rect : this.layer.rectOf(rec);
  }

  _screen(rec) {
    const r = this._rect(rec);
    const { x, y, z } = this.board.cam;
    return { left: r[0] * z + x, top: r[1] * z + y, width: (r[2] - r[0]) * z, height: (r[3] - r[1]) * z,
             radius: rec.kind === 'image' ? 14 * z : 8 };
  }

  // What's under a screen point on the selected card: a corner ('nw' | 'ne' | 'sw' | 'se'),
  // 'body', or null. Handles shrink on very small cards so the middle still moves it.
  hit(sx, sy) {
    const rec = this.id && this.layer.records.get(this.id);
    if (!rec) return null;
    const r = this._screen(rec);
    const reach = clamp(Math.min(r.width, r.height) * 0.3, 10, HANDLE_HIT);
    const corners = {
      nw: [r.left, r.top], ne: [r.left + r.width, r.top],
      sw: [r.left, r.top + r.height], se: [r.left + r.width, r.top + r.height],
    };
    let best = null, bestD = reach;
    for (const [name, [cx, cy]] of Object.entries(corners)) {
      const d = Math.hypot(sx - cx, sy - cy);
      if (d <= bestD) { best = name; bestD = d; }
    }
    if (best) return best;
    if (sx >= r.left && sx <= r.left + r.width && sy >= r.top && sy <= r.top + r.height) return 'body';
    return null;
  }

  // ---- drag (board calls these: begin on press, move on every pointermove, end on release)
  begin(part, sx, sy) {
    const rec = this.id && this.layer.records.get(this.id);
    if (!rec || !part) return false;
    const r = this.layer.rectOf(rec);
    this.drag = { part, rec, id: this.id, sx, sy, rect0: r, rect: r.slice(), moved: false };
    return true;
  }

  move(sx, sy) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(sx - d.sx, sy - d.sy) <= DRAG_SLOP) return;
      d.moved = true; // from here the card stays pinned under the finger (no lag behind it)
      this._lift(d.rec, true);
      this.el.classList.add(d.part === 'body' ? 'moving' : 'resizing');
    }
    const z = this.board.cam.z;
    const dx = (sx - d.sx) / z, dy = (sy - d.sy) / z;
    const [x0, y0, x1, y1] = d.rect0;
    const w0 = x1 - x0, h0 = y1 - y0;
    if (d.part === 'body') {
      d.rect = [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
    } else {
      // the opposite corner is the anchor; the size follows the finger along the diagonal
      const west = d.part.includes('w'), north = d.part.includes('n');
      const ax = west ? x1 : x0, ay = north ? y1 : y0;
      const vx = (west ? x0 : x1) - ax, vy = (north ? y0 : y1) - ay;
      let k = ((vx + dx) * vx + (vy + dy) * vy) / (vx * vx + vy * vy);
      const minK = Math.min(1, MIN_SIDE / z / Math.min(w0, h0));
      k = clamp(k, minK, Math.max(1, MAX_WORLD / Math.max(w0, h0)));
      const w = w0 * k, h = h0 * k;
      const nx = west ? ax - w : ax, ny = north ? ay - h : ay;
      d.rect = [nx, ny, nx + w, ny + h];
    }
    // GPU only while moving: translate + scale from the committed box (world units)
    const s = (d.rect[2] - d.rect[0]) / w0;
    const st = d.rec.host.style;
    st.transformOrigin = '0 0';
    st.transform = `translate(${d.rect[0] - x0}px, ${d.rect[1] - y0}px) scale(${s})`;
    this.sync();
  }

  // Let go. Returns true if the card moved (so it wasn't a tap).
  end(cancelled = false) {
    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    this.el.classList.remove('moving', 'resizing');
    const st = d.rec.host.style;
    if (d.moved && !cancelled && this.layer.records.get(d.id) === d.rec) {
      const [x0, y0, x1, y1] = d.rect;
      const g = { x: round2(x0), y: round2(y0), width: round2(x1 - x0), height: round2(y1 - y0) };
      // commit the box and drop the transform in the same frame: no flicker
      this.layer.place(d.id, g);
      st.transform = '';
      st.transformOrigin = '';
      this._lift(d.rec, false);
      this.sync();
      this.onCommit(d.id, g);
      return true;
    }
    st.transform = '';
    st.transformOrigin = '';
    this._lift(d.rec, false);
    this.sync();
    return d.moved;
  }

  _lift(rec, on) {
    rec.host.classList.remove('enter'); // an entrance animation would fight the transform
    rec.host.classList.toggle('lifted', on);
  }

  // Keep the outline, handles and pill on the card (camera moves, drags, remote changes).
  sync() {
    if (!this.id) return;
    const rec = this.layer.records.get(this.id);
    if (!rec || !this.layer.visible) {
      this.clear();
      return;
    }
    const r = this._screen(rec);
    const pad = 3;
    const bs = this.box.style;
    bs.transform = `translate(${r.left - pad}px, ${r.top - pad}px)`;
    bs.width = `${r.width + pad * 2}px`;
    bs.height = `${r.height + pad * 2}px`;
    bs.borderRadius = `${r.radius + pad}px`;
    if (!this._bar) this._bar = { w: this.bar.offsetWidth || 96, h: this.bar.offsetHeight || 48 };
    const { w: bw, h: bh } = this._bar;
    const W = window.innerWidth, H = window.innerHeight;
    const bx = clamp(r.left + r.width / 2 - bw / 2, 8, W - bw - 8);
    let by = r.top - bh - 14;
    if (by < 64) by = Math.min(r.top + r.height + 14, H - bh - 100);
    this.bar.style.transform = `translate(${bx}px, ${by}px)`;
  }
}
