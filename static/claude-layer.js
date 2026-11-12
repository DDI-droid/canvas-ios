// "Claude layer": sanitized SVG items placed in world coordinates, moving with the board.
// Each item renders inside its own shadow root so <style> rules and ids stay scoped.
import DOMPurify from './vendor/dompurify/purify.es.mjs';
import { rectsIntersect, unionRect } from './util.js';
import { withKey } from './api.js';
import { BAR, LIVE_KINDS, makeLiveCard } from './livecards.js';

// A live page runs in a sandboxed frame, so a board picture can't draw it from here: the server
// keeps a picture of it, made in headless Chrome at the card's size (pageshot.py). Asking for it
// also gets it made or remade when it's missing or older than the page.
const pageShotUrl = (rec) => (rec.kind === 'page' && rec.item && rec.item.src && !rec.item.browsing
  ? `${rec.item.src}shot.png?w=${Math.round(rec.w)}&h=${Math.round(rec.h - BAR)}` : null);
async function loadPageShot(rec) {
  const url = pageShotUrl(rec);
  if (!url) return null;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await Promise.race([img.decode(), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 1500))]);
    return img;
  } catch {
    return null; // not made yet: the card shows as a plain frame this time
  }
}

const CARD_STYLE =
  ':host{all:initial;display:block;position:absolute;contain:layout style}' +
  '.card{position:absolute;inset:0;border-radius:14px;overflow:hidden;background:#fff;' +
  'box-shadow:0 0 0 .5px rgba(0,0,0,.08),0 2px 6px rgba(0,0,0,.06),0 12px 32px rgba(0,0,0,.10);' +
  'transition:box-shadow 220ms cubic-bezier(.2,.85,.25,1)}' +
  // lifted while you move or resize it
  ':host(.lifted) .card{box-shadow:0 0 0 .5px rgba(0,0,0,.08),0 10px 24px rgba(0,0,0,.12),0 28px 64px rgba(0,0,0,.18)}' +
  'img{display:block;width:100%;height:100%;object-fit:cover;-webkit-user-drag:none;user-select:none}' +
  '.cap{position:absolute;left:0;top:100%;margin-top:8px;font:500 12px/1.3 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;' +
  'letter-spacing:-.005em;color:#8a6a5c;white-space:nowrap}';

// Board cards show a light copy of a photo (server.py makes <hash>.preview.jpg, at most 1280 px
// on its long side): a 12 MP photo would hold ~48 MB of memory per card. Zoom in far enough and
// the card switches to the full image; the full-screen viewer always shows the full image. GIFs
// (they may move), AVIF and HEIC keep their original.
const PREVIEW_SIDE = 1280;
const previewOf = (src) => {
  const m = /^(\/api\/media\/[a-f0-9]{16,64})\.(png|jpe?g|webp)$/i.exec(src || '');
  return m ? `${m[1]}.preview.jpg` : null;
};

const purifier = DOMPurify(window);
const SVG_NS = 'http://www.w3.org/2000/svg';
const URL_RE = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi;

function hasExternalRef(value) {
  if (/javascript:|vbscript:|data:text\/html|expression\s*\(|@import/i.test(value)) return true;
  for (const m of String(value).matchAll(URL_RE)) {
    if (!m[2].trim().startsWith('#')) return true;
  }
  return false;
}

purifier.addHook('uponSanitizeAttribute', (node, data) => {
  const name = (data.attrName || '').toLowerCase();
  const value = String(data.attrValue || '');
  if (name.startsWith('on')) data.keepAttr = false;
  else if (name === 'href' || name === 'xlink:href' || name === 'src') {
    if (!value.trim().startsWith('#')) data.keepAttr = false;
  } else if (hasExternalRef(value)) data.keepAttr = false;
});

purifier.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'style' && node.textContent) {
    node.textContent = node.textContent
      .replace(/@import[^;]*;?/gi, '')
      .replace(URL_RE, (m, q, target) => (target.trim().startsWith('#') ? m : 'none'))
      .replace(/expression\s*\(/gi, '');
  }
});

const PURIFY_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'foreignobject', 'script', 'image', 'feImage', 'a', 'animate', 'animatemotion',
    'animatetransform', 'animatecolor', 'set', 'iframe', 'audio', 'video', 'canvas', 'font', 'font-face'],
  RETURN_DOM_FRAGMENT: true,
};

function parseLen(v) {
  if (v == null) return null;
  const m = /^\s*([0-9.]+)\s*(px|pt|pc|mm|cm|in|em|rem)?\s*$/i.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'px').toLowerCase();
  const k = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, rem: 16 }[unit] || 1;
  return n * k;
}

export function sanitizeSvg(markup) {
  if (typeof markup !== 'string' || !markup.includes('<')) return null;
  const frag = purifier.sanitize(markup, PURIFY_CONFIG);
  const svg = frag && frag.querySelector ? frag.querySelector('svg') : null;
  if (!svg || svg.namespaceURI !== SVG_NS) return null;
  return document.importNode(svg, true);
}

function measure(svg, item) {
  let vw = null, vh = null;
  const vb = svg.getAttribute('viewBox');
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) {
      vw = p[2];
      vh = p[3];
    }
  }
  const aw = parseLen(svg.getAttribute('width'));
  const ah = parseLen(svg.getAttribute('height'));
  if (!vw) {
    vw = aw || 300;
    vh = ah || (aw ? aw : 150);
    svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
  }
  const ratio = vh / vw;
  const w = item.width > 0 ? item.width : aw || vw;
  const h = item.height > 0 ? item.height : w * ratio;
  return { w, h };
}

export class ClaudeLayer extends EventTarget {
  constructor(el) {
    super();
    this.el = el;
    this.records = new Map(); // id -> { item, host, svg, w, h }
    this.visible = true;
  }

  setVisible(on) {
    this.visible = !!on;
    this.el.classList.toggle('hidden', !this.visible);
    this._changed();
  }

  _changed() {
    this.dispatchEvent(new Event('change'));
  }

  // same picture, maybe somewhere else: only the geometry needs updating
  static sameContent(a, b) {
    return (a.type || '') === (b.type || '') && a.svg === b.svg && a.src === b.src && (a.label || null) === (b.label || null)
      && (a.page || null) === (b.page || null) && (a.browser || null) === (b.browser || null)
      && ((a.browsing || {}).browser || null) === ((b.browsing || {}).browser || null);
  }

  // Move / resize an item in place (no re-render, so no flicker and no entrance animation).
  // g: {x, y, width?, height?, ts?} in world units.
  place(id, g) {
    const rec = this.records.get(id);
    if (!rec || !g) return null;
    const it = rec.item;
    if (Number.isFinite(g.x)) it.x = g.x;
    if (Number.isFinite(g.y)) it.y = g.y;
    if (g.width > 0) {
      const ratio = rec.h / rec.w;
      rec.w = g.width;
      rec.h = g.height > 0 ? g.height : g.width * ratio;
      it.width = rec.w;
      it.height = rec.h;
    }
    if (g.ts) it.ts = g.ts;
    const s = rec.host.style;
    s.left = `${it.x || 0}px`;
    s.top = `${it.y || 0}px`;
    s.width = `${rec.w}px`;
    s.height = `${rec.h}px`;
    this._changed();
    return rec;
  }

  sync(cam) {
    this.el.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  }

  setAll(items) {
    const keep = new Set();
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || typeof it.id !== 'string') continue;
      keep.add(it.id);
      const cur = this.records.get(it.id);
      if (!cur) this.upsert(it, { animate: false });
      else if (cur.item.ts !== it.ts) {
        if (ClaudeLayer.sameContent(cur.item, it)) this.place(it.id, it);
        else this.upsert(it, { animate: false });
      }
    }
    for (const id of [...this.records.keys()]) if (!keep.has(id)) this.remove(id, { animate: false });
    this._changed();
  }

  upsert(item, { animate = true } = {}) {
    if (!item || typeof item.id !== 'string') return null;
    if (item.type === 'image') return this._upsertImage(item, animate);
    if (LIVE_KINDS.has(item.type)) return this._upsertLive(item, animate);
    const svg = sanitizeSvg(item.svg);
    if (!svg) {
      this.remove(item.id, { animate: false });
      return null;
    }
    const { w, h } = measure(svg, item);
    let rec = this.records.get(item.id);
    let host;
    if (rec) {
      host = rec.host;
    } else {
      host = document.createElement('div');
      host.className = 'claude-item';
      host.attachShadow({ mode: 'open' });
      this.el.appendChild(host);
    }
    const display = svg.cloneNode(true);
    display.setAttribute('width', '100%');
    display.setAttribute('height', '100%');
    const root = host.shadowRoot;
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent =
      ':host{all:initial;display:block;position:absolute;contain:layout style}' +
      'svg{display:block;width:100%;height:100%;overflow:visible}' +
      '.cap{position:absolute;left:0;top:100%;margin-top:6px;font:500 12px/1.3 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;' +
      'letter-spacing:-.005em;color:#8a6a5c;white-space:nowrap}';
    root.append(style, display);
    if (item.label) {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = item.label;
      root.append(cap);
    }
    host.style.left = `${item.x || 0}px`;
    host.style.top = `${item.y || 0}px`;
    host.style.width = `${w}px`;
    host.style.height = `${h}px`;
    host.dataset.id = item.id;
    if (animate) {
      host.classList.remove('enter');
      void host.offsetWidth;
      host.classList.add('enter');
    }
    rec = { item, host, svg, w, h };
    this.records.set(item.id, rec);
    this._changed();
    return rec;
  }

  // An image card: a calm rounded card at its world size. The image is served by the canvas
  // server (/api/media/…, with the key), so it's same-origin: snapshots can include it.
  _upsertImage(item, animate) {
    let rec = this.records.get(item.id);
    let host;
    if (rec) {
      host = rec.host;
    } else {
      host = document.createElement('div');
      host.className = 'claude-item media-item';
      host.attachShadow({ mode: 'open' });
      this.el.appendChild(host);
    }
    const root = host.shadowRoot;
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent = CARD_STYLE;
    const card = document.createElement('div');
    card.className = 'card';
    const img = document.createElement('img');
    img.alt = item.label || 'Image';
    img.decoding = 'async';
    img.draggable = false;
    const preview = previewOf(item.src);
    img.src = withKey(preview || item.src);
    card.append(img);
    root.append(style, card);
    if (item.label) {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = item.label;
      root.append(cap);
    }
    const w = item.width > 0 ? item.width : 420;
    const aspect = item.height > 0 ? item.height / w : item.aspect > 0 ? item.aspect : 0.66;
    const h = w * aspect;
    host.style.left = `${item.x || 0}px`;
    host.style.top = `${item.y || 0}px`;
    host.style.width = `${w}px`;
    host.style.height = `${h}px`;
    host.dataset.id = item.id;
    host.dataset.kind = 'image';
    if (animate) {
      host.classList.remove('enter');
      void host.offsetWidth;
      host.classList.add('enter');
    }
    rec = { item, host, img, kind: 'image', w, h, full: !preview };
    this.records.set(item.id, rec);
    if (preview) {
      img.addEventListener('error', () => { // no preview (old server, odd file): the original
        if (rec.full) return;
        rec.full = true;
        img.src = withKey(item.src);
      }, { once: true });
    }
    // no known size yet: take the image's own shape once it loads
    if (!(item.height > 0) && !(item.aspect > 0)) {
      img.addEventListener('load', () => {
        if (!img.naturalWidth || this.records.get(item.id) !== rec) return;
        rec.h = rec.w * (img.naturalHeight / img.naturalWidth);
        host.style.height = `${rec.h}px`;
        this._changed();
      }, { once: true });
    }
    this._changed();
    return rec;
  }

  // A video, live page or browser card (livecards.js). The same card moved or relabelled keeps
  // running (no reload of its page, no restart of its video); anything else rebuilds it.
  _upsertLive(item, animate) {
    let rec = this.records.get(item.id);
    if (rec && rec.live && ClaudeLayer.sameContent(rec.item, item)) {
      this.place(item.id, item);
      return rec;
    }
    if (rec) this.remove(item.id, { animate: false });
    const host = document.createElement('div');
    host.className = 'claude-item media-item live-item';
    host.dataset.id = item.id;
    host.dataset.kind = item.type;
    host.attachShadow({ mode: 'open' });
    this.el.appendChild(host);
    const w = item.width > 0 ? item.width : 600;
    const h = item.height > 0 ? item.height : w * (item.aspect > 0 ? item.aspect : 0.66) + BAR;
    host.style.left = `${item.x || 0}px`;
    host.style.top = `${item.y || 0}px`;
    host.style.width = `${w}px`;
    host.style.height = `${h}px`;
    rec = { item, host, kind: item.type, w, h, live: null };
    rec.live = makeLiveCard(rec, host.shadowRoot, this.liveOpts || {});
    const shot = pageShotUrl(rec);
    if (shot) fetch(shot).catch(() => {}); // so its picture is ready for the next board picture
    if (animate) host.classList.add('enter');
    this.records.set(item.id, rec);
    this._changed();
    return rec;
  }

  // On screen, live cards run; off screen (or the page hidden) they rest.
  // (`focused`: the card open full screen; its full-screen copy runs instead)
  updateVisibility(view) {
    for (const rec of this.records.values()) {
      if (!rec.live) continue;
      rec.live.setVisible(this.visible && !document.hidden && !!view && rec.item.id !== this.focused
        && rectsIntersect(this.rectOf(rec), view));
    }
  }

  // the live card showing a page (for its live data)
  byPage(token) {
    for (const rec of this.records.values()) if (rec.live && rec.item.page === token) return rec;
    return null;
  }

  remove(id, { animate = true } = {}) {
    const rec = this.records.get(id);
    if (!rec) return;
    this.records.delete(id);
    if (rec.live) rec.live.destroy();
    if (animate) {
      rec.host.classList.add('leave');
      setTimeout(() => rec.host.remove(), 220);
    } else rec.host.remove();
    this._changed();
  }

  clear({ animate = true } = {}) {
    for (const id of [...this.records.keys()]) this.remove(id, { animate });
  }

  get count() {
    return this.records.size;
  }

  rectOf(rec) {
    const x = rec.item.x || 0, y = rec.item.y || 0;
    return [x, y, x + rec.w, y + rec.h];
  }

  bounds() {
    if (!this.visible) return null;
    let r = null;
    for (const rec of this.records.values()) r = unionRect(r, this.rectOf(rec));
    return r;
  }

  // The item under a world point. The smallest wins, so a card sitting on a big diagram is
  // still easy to pick; among equal sizes, the top-most.
  hitTest(wx, wy, pad = 0) {
    if (!this.visible) return null;
    let best = null, bestArea = Infinity;
    for (const rec of this.records.values()) {
      const [x0, y0, x1, y1] = this.rectOf(rec);
      if (wx >= x0 - pad && wx <= x1 + pad && wy >= y0 - pad && wy <= y1 + pad) {
        const area = (x1 - x0) * (y1 - y0);
        if (area <= bestArea) { best = rec.item.id; bestArea = area; }
      }
    }
    return best;
  }

  // The camera settled: a photo card shown bigger than its preview can draw sharply switches
  // to the full image (decoded first, so it never flashes). It stays full from then on.
  sharpen(cam, view, dpr = 1) {
    for (const rec of this.records.values()) {
      if (rec.kind !== 'image' || rec.full || !rectsIntersect(this.rectOf(rec), view)) continue;
      if (Math.max(rec.w, rec.h) * cam.z * dpr <= PREVIEW_SIDE * 1.15) continue;
      rec.full = true;
      const next = new Image();
      next.decoding = 'async';
      next.src = withKey(rec.item.src);
      next.decode().then(() => {
        if (this.records.get(rec.item.id) === rec) rec.img.src = next.src;
      }).catch(() => {});
    }
  }

  flash(id) {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.host.classList.remove('pulse');
    void rec.host.offsetWidth;
    rec.host.classList.add('pulse');
  }

  // Rasterise visible items into a 2D context whose transform maps world -> pixels.
  async drawInto(ctx, rect, scale, alpha = 0.6) {
    if (!this.visible) return 0;
    let n = 0;
    for (const rec of this.records.values()) {
      const r = this.rectOf(rec);
      if (!rectsIntersect(r, rect)) continue;
      if (rec.kind === 'image') {
        try {
          if (!rec.img.complete) await rec.img.decode();
          ctx.globalAlpha = alpha;
          ctx.drawImage(rec.img, r[0], r[1], rec.w, rec.h);
          ctx.globalAlpha = 1;
          n++;
        } catch { /* not loaded: skip */ }
        continue;
      }
      if (rec.live) {
        // a live card in the snapshot: its frame, title, and what it shows if we can draw it
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#f6f6f8';
        ctx.fillRect(r[0], r[1], rec.w, BAR);
        ctx.fillStyle = rec.kind === 'video' ? '#111' : '#fff';
        ctx.fillRect(r[0], r[1] + BAR, rec.w, rec.h - BAR);
        ctx.strokeStyle = 'rgba(0,0,0,.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(r[0], r[1], rec.w, rec.h);
        ctx.fillStyle = '#3a3a3c';
        ctx.font = '600 14px -apple-system, system-ui, sans-serif';
        ctx.fillText(`${{ video: 'Video', page: 'Live page', browser: 'Browser' }[rec.kind]}: ${rec.live.titleEl.textContent || ''}`.slice(0, 80), r[0] + 10, r[1] + 20);
        let pic = rec.live.stream ? rec.live.stream.img : rec.kind === 'video' ? rec.live.media : null;
        if (!pic && rec.kind === 'page') pic = await loadPageShot(rec);
        try { if (pic && (pic.naturalWidth || pic.videoWidth)) ctx.drawImage(pic, r[0], r[1] + BAR, rec.w, rec.h - BAR); } catch { /* not drawable */ }
        ctx.globalAlpha = 1;
        n++;
        continue;
      }
      const pw = Math.max(1, Math.round(rec.w * scale));
      const ph = Math.max(1, Math.round(rec.h * scale));
      if (pw * ph > 16e6) continue;
      const clone = rec.svg.cloneNode(true);
      clone.setAttribute('width', String(pw));
      clone.setAttribute('height', String(ph));
      const xml = new XMLSerializer().serializeToString(clone);
      const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
      try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        ctx.globalAlpha = alpha;
        ctx.drawImage(img, r[0], r[1], rec.w, rec.h);
        ctx.globalAlpha = 1;
        n++;
      } catch {
        /* unrenderable SVG: skip */
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return n;
  }
}
