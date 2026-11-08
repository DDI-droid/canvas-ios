// Full-screen viewer for media cards on the board (Phase 1: images).
//
// Opening, the card itself grows from its place on the board into the middle of the screen
// while the canvas dims and blurs behind it; closing, it shrinks back into its spot. Inside:
// pinch to zoom, double-tap to zoom in/out, drag to pan while zoomed. To close: the ✕ in the
// corner, a tap on the dimmed area around the card, or Esc. No swipe to close: swipes clash
// with system gestures (Safari's full-screen exit, the iPadOS menu bar), and the content
// itself owns the finger (zoom here; scrolling pages and rotating 3D later).

const EASE = 'cubic-bezier(.2, .85, .25, 1)';
const DUR = 420;
const MAX_ZOOM = 8;

export class Viewer {
  constructor(root) {
    this.root = root;
    this.bg = root.querySelector('.stage-bg');
    this.frame = root.querySelector('.stage-frame');
    this.title = root.querySelector('.stage-title');
    this.closeBtn = root.querySelector('.stage-close');
    this.media = null;          // the <img> inside the frame
    this.from = null;           // () => DOMRect of the card on the board
    this.onHide = null;         // (hidden: boolean) => void: hide the card while it's "lifted"
    this.isOpen = false;
    this.busy = false;
    this.z = 1; this.tx = 0; this.ty = 0;   // zoom and pan inside the frame
    this.closeBtn.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => { if (this.isOpen && e.key === 'Escape') this.close(); });
    window.addEventListener('resize', () => { if (this.isOpen && !this.busy) this._layout(false); });
    this._bindGestures();
  }

  // Open an image from a card. aspect = height / width.
  async show({ src, title = '', aspect = 0.66, from, onHide }) {
    if (this.isOpen || this.busy) return;
    this.busy = true;
    this.from = from;
    this.onHide = onHide || null;
    this.title.textContent = title;
    const img = document.createElement('img');
    img.alt = title || 'Image';
    img.draggable = false;
    img.src = src;
    try { await Promise.race([img.decode(), new Promise((r) => setTimeout(r, 700))]); } catch { /* show anyway */ }
    if (img.naturalWidth && img.naturalHeight) aspect = img.naturalHeight / img.naturalWidth;
    this.aspect = aspect;
    this.media = img;
    this.frame.replaceChildren(img);
    this.z = 1; this.tx = 0; this.ty = 0;
    this._applyZoom(false);

    this.root.hidden = false;
    this._layout(false);
    const start = this._cardTransform();
    this.frame.style.transition = 'none';
    this.frame.style.transform = start;
    this.frame.style.borderRadius = '14px';
    void this.frame.offsetWidth;
    this.onHide && this.onHide(true);
    requestAnimationFrame(() => {
      this.root.classList.add('open');
      this.frame.style.transition = `transform ${DUR}ms ${EASE}, border-radius ${DUR}ms ${EASE}`;
      this.frame.style.transform = 'none';
      this.frame.style.borderRadius = '10px';
      setTimeout(() => { this.busy = false; this.isOpen = true; }, DUR);
    });
  }

  close() {
    if (!this.isOpen || this.busy) return;
    this.busy = true;
    this.isOpen = false;
    // back to normal zoom, then shrink into the card
    this.z = 1; this.tx = 0; this.ty = 0;
    this._applyZoom(true);
    this.root.classList.remove('open');
    this.bg.style.opacity = '';
    this.frame.style.transition = `transform ${DUR}ms ${EASE}, border-radius ${DUR}ms ${EASE}`;
    this.frame.style.transform = this._cardTransform();
    this.frame.style.borderRadius = '14px';
    setTimeout(() => {
      this.root.hidden = true;
      this.frame.replaceChildren();
      this.frame.style.transition = 'none';
      this.frame.style.transform = '';
      this.media = null;
      this.onHide && this.onHide(false);
      this.busy = false;
    }, DUR);
  }

  // ---- geometry
  _target() {
    const W = window.innerWidth, H = window.innerHeight;
    const top = 60, side = 20, bottom = 24;
    let w = W - side * 2, h = w * this.aspect;
    if (h > H - top - bottom) { h = H - top - bottom; w = h / this.aspect; }
    return { left: (W - w) / 2, top: top + (H - top - bottom - h) / 2, width: w, height: h };
  }

  _layout() {
    const t = this._target();
    Object.assign(this.frame.style, { left: `${t.left}px`, top: `${t.top}px`, width: `${t.width}px`, height: `${t.height}px` });
    this.box = t;
  }

  // the transform that puts the full-screen frame exactly over the card on the board
  _cardTransform() {
    const t = this.box || this._target();
    const r = this.from ? this.from() : null;
    if (!r || !r.width) return 'translate(0px, 40px) scale(.92)';
    return `translate(${r.left - t.left}px, ${r.top - t.top}px) scale(${r.width / t.width}, ${r.height / t.height})`;
  }

  _applyZoom(animate) {
    if (!this.media) return;
    this.media.style.transition = animate ? `transform 300ms ${EASE}` : 'none';
    this.media.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.z})`;
  }

  _clampPan() {
    const b = this.box;
    if (!b) return;
    const minX = b.width - b.width * this.z, minY = b.height - b.height * this.z;
    this.tx = Math.min(0, Math.max(minX, this.tx));
    this.ty = Math.min(0, Math.max(minY, this.ty));
  }

  _zoomAt(px, py, z) {   // px, py: point inside the frame (px)
    z = Math.min(MAX_ZOOM, Math.max(1, z));
    const k = z / this.z;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.z = z;
    this._clampPan();
  }

  // ---- gestures (pointer events, so fingers, Pencil and mouse all work)
  _bindGestures() {
    const f = this.frame;
    const pts = new Map();
    let g = null;            // current gesture
    let lastTap = null;
    const local = (e) => { const r = f.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    f.addEventListener('pointerdown', (e) => {
      if (!this.isOpen) return;
      f.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        g = { kind: 'one', x0: e.clientX, y0: e.clientY, t0: performance.now(), tx0: this.tx, ty0: this.ty, moved: false };
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const r = f.getBoundingClientRect();
        g = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.z, tx0: this.tx, ty0: this.ty,
              cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top };
      }
    });

    f.addEventListener('pointermove', (e) => {
      if (!g || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.kind === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.z = g.z0; this.tx = g.tx0; this.ty = g.ty0;
        this._zoomAt(g.cx, g.cy, g.z0 * d / g.d0);
        this._applyZoom(false);
        return;
      }
      if (g.kind !== 'one') return;
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (!g.moved && Math.hypot(dx, dy) > 6) {
        g.moved = true;
        g.mode = this.z > 1.01 ? 'pan' : 'none';
      }
      if (g.mode === 'pan') {
        this.tx = g.tx0 + dx; this.ty = g.ty0 + dy;
        this._clampPan();
        this._applyZoom(false);
      }
    });

    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.kind === 'pinch') {
        if (pts.size === 0) {
          if (this.z < 1.02) { this.z = 1; this.tx = 0; this.ty = 0; this._applyZoom(true); }
          g = null;
        }
        return;
      }
      const dt = performance.now() - g.t0;
      if (!g.moved && dt < 300) {
        // a tap: two in a row zoom in at that spot, or back out
        const p = local(e), now = performance.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
          if (this.z > 1.01) { this.z = 1; this.tx = 0; this.ty = 0; } else this._zoomAt(p.x, p.y, 2.5);
          this._applyZoom(true);
          lastTap = null;
        } else {
          lastTap = { t: now, x: p.x, y: p.y };
        }
      }
      g = null;
    };
    f.addEventListener('pointerup', end);
    f.addEventListener('pointercancel', end);

    // tapping the dimmed backdrop closes too
    this.bg.addEventListener('click', () => this.close());
    // trackpad / mouse wheel zoom (handy on the PC)
    f.addEventListener('wheel', (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      const p = local(e);
      this._zoomAt(p.x, p.y, this.z * Math.exp(-e.deltaY * 0.002));
      this._applyZoom(false);
    }, { passive: false });
  }
}
