// "Claude layer": sanitized SVG items placed in world coordinates, moving with the board.
// Each item renders inside its own shadow root so <style> rules and ids stay scoped.
import DOMPurify from './vendor/dompurify/purify.es.mjs';
import { rectsIntersect, unionRect } from './util.js';

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
      if (!cur || cur.item.ts !== it.ts || cur.item.svg !== it.svg) this.upsert(it, { animate: false });
    }
    for (const id of [...this.records.keys()]) if (!keep.has(id)) this.remove(id, { animate: false });
  }

  upsert(item, { animate = true } = {}) {
    if (!item || typeof item.id !== 'string') return null;
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
    return rec;
  }

  remove(id, { animate = true } = {}) {
    const rec = this.records.get(id);
    if (!rec) return;
    this.records.delete(id);
    if (animate) {
      rec.host.classList.add('leave');
      setTimeout(() => rec.host.remove(), 220);
    } else rec.host.remove();
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

  hitTest(wx, wy, pad = 0) {
    if (!this.visible) return null;
    const recs = [...this.records.values()].reverse();
    for (const rec of recs) {
      const [x0, y0, x1, y1] = this.rectOf(rec);
      if (wx >= x0 - pad && wx <= x1 + pad && wy >= y0 - pad && wy <= y1 + pad) return rec.item.id;
    }
    return null;
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
