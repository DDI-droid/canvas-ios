// Live cards on the board: video, live pages (an agent's HTML, charts, 3D models) and browser
// tabs. One set of rules, the same as every card (cards.js):
//   - a finger on the card's content USES it: plays the video, scrolls / taps / turns the page,
//     taps and scrolls the browser tab. (The content never receives touches itself; the board
//     forwards the finger, so the Pencil keeps drawing over every card.)
//   - its title strip (or a long-press, or tapping it while selected) ARRANGES it: select, drag,
//     resize.
//   - double-tap opens it full screen; the ✕ brings it back.
// Off screen, a card rests: pages are told to pause, browsers stop fetching pictures, videos pause.
import { api, KEY, SESSION, withKey } from './api.js';

export const BAR = 30;                                    // world px: the title strip
export const BACK_W = 40;                                 // world px: ‹ at the start of a browsing page's strip
export const LIVE_KINDS = new Set(['video', 'page', 'browser']);
const BROWSER_W = 1280, BROWSER_H = 800;                   // a browser tab's own pixels (browser.py)

export const LIVE_STYLE =
  ':host{all:initial;display:block;position:absolute;contain:layout style}' +
  '.card{position:absolute;inset:0;border-radius:14px;overflow:hidden;background:#fff;display:flex;flex-direction:column;' +
  'box-shadow:0 0 0 .5px rgba(0,0,0,.08),0 2px 6px rgba(0,0,0,.06),0 12px 32px rgba(0,0,0,.10);transition:box-shadow 220ms cubic-bezier(.2,.85,.25,1)}' +
  ':host(.lifted) .card{box-shadow:0 0 0 .5px rgba(0,0,0,.08),0 10px 24px rgba(0,0,0,.12),0 28px 64px rgba(0,0,0,.18)}' +
  '.bar{flex:none;height:' + BAR + 'px;display:flex;align-items:center;gap:7px;padding:0 10px 0 12px;' +
  'font:600 12.5px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;letter-spacing:-.005em;color:#3a3a3c;' +
  'background:#f6f6f8;border-bottom:.5px solid rgba(0,0,0,.08);user-select:none}' +
  '.bar .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.bar .k{flex:none;font-weight:500;color:#8e8e93}' +
  '.bar .dot{flex:none;width:7px;height:7px;border-radius:50%;background:#34c759;box-shadow:0 0 0 3px rgba(52,199,89,.18)}' +
  '.bar .back{flex:none;margin:0 -2px 0 -4px;font:600 22px/1 -apple-system,system-ui,sans-serif;color:#0a84ff}' +
  '.bar .grip{flex:none;width:14px;height:10px;opacity:.35;background:radial-gradient(circle,#3a3a3c 1.1px,transparent 1.4px) 0 0/5px 5px}' +
  // (white behind a page only once it shows: until then the board's paper colour, see revealOnLoad)
  '.body{position:relative;flex:1;min-height:0;background:#fff;transition:background-color 0s linear .22s}' +
  '.body.loading{background:var(--paper,#f8f6f1);transition:none}' +
  '.body.dark{background:#111}' +
  'iframe,video,img.frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;pointer-events:none}' +
  'iframe{transition:opacity .2s ease-out}' +
  '.body.loading iframe{opacity:0}' +
  'video{object-fit:contain;background:#111}' +
  'img.frame{object-fit:cover;background:#fff}' +
  '.play{position:absolute;left:50%;top:50%;width:62px;height:62px;margin:-31px 0 0 -31px;border-radius:50%;' +
  'background:rgba(20,20,22,.52);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:opacity .2s}' +
  '.play::after{content:"";position:absolute;left:25px;top:19px;border-style:solid;border-width:12px 0 12px 19px;border-color:transparent transparent transparent #fff}' +
  '.body.playing .play{opacity:0}' +
  '.prog{position:absolute;left:0;bottom:0;height:3px;width:0;background:rgba(255,255,255,.92)}' +
  '.wait{position:absolute;inset:0;display:grid;place-items:center;color:#8e8e93;font:500 13px -apple-system,system-ui,sans-serif}' +
  '.cap{display:none}';

// What each kind says in its strip, before its own title.
const KIND_LABEL = { video: 'Video', page: 'Page', browser: '' };

class LiveCard {
  constructor(rec, root, opts) {
    this.rec = rec;
    this.item = rec.item;
    this.opts = opts;
    this.visible = false;
    const card = document.createElement('div');
    card.className = 'card';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = '<span class="grip"></span><span class="t"></span><span class="k"></span>';
    this.titleEl = bar.querySelector('.t');
    this.kindEl = bar.querySelector('.k');
    this.body = document.createElement('div');
    this.body.className = 'body';
    card.append(bar, this.body);
    root.append(card);
    this.bar = bar;
    this.setTitle(this.item.label || '');
  }

  setTitle(t) {
    this.titleEl.textContent = t || KIND_LABEL[this.item.type] || '';
    this.kindEl.textContent = t ? KIND_LABEL[this.item.type] || '' : '';
  }

  // content size in its own CSS px (= world units)
  get cw() { return this.rec.w; }
  get ch() { return Math.max(1, this.rec.h - BAR); }

  setVisible(on) { this.visible = on; }
  input() {}
  data() {}
  reload() {}
  destroy() {}
}

// ---- video: preloads nothing until played; a first frame stands in until then
class VideoCard extends LiveCard {
  constructor(rec, root, opts) {
    super(rec, root, opts);
    this.body.classList.add('dark');
    const v = document.createElement('video');
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'none';
    this.media = v;
    this.name = (this.item.src || '').split('/').pop();
    this.posterUrl = withKey(this.item.src.replace(/\.[a-z0-9]+$/i, '.poster.jpg'));
    v.poster = this.posterUrl;
    v.src = withKey(this.item.src);
    const play = document.createElement('div');
    play.className = 'play';
    const prog = document.createElement('div');
    prog.className = 'prog';
    this.body.append(v, play, prog);
    v.addEventListener('play', () => this.body.classList.add('playing'));
    v.addEventListener('pause', () => this.body.classList.remove('playing'));
    v.addEventListener('ended', () => this.body.classList.remove('playing'));
    v.addEventListener('timeupdate', () => { prog.style.width = v.duration ? `${(100 * v.currentTime) / v.duration}%` : '0'; });
    // no first frame yet (an agent's upload): the first page that shows the video makes one
    const probe = new Image();
    probe.onerror = () => this._makePoster();
    probe.src = this.posterUrl;
  }

  async _makePoster() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = withKey(this.item.src);
    try {
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(rej, 20000); });
      // the real shape: correct the card if it was placed with a guess
      if (v.videoWidth && this.opts.onAspect) this.opts.onAspect(this.rec, v.videoHeight / v.videoWidth);
      v.currentTime = Math.min(0.5, (v.duration || 1) / 10);
      await new Promise((res) => { v.onseeked = res; setTimeout(res, 3000); });
      const k = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * k);
      c.height = Math.round(v.videoHeight * k);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
      c.width = c.height = 0;
      if (!blob) return;
      await api.post(`/api/media/poster?for=${encodeURIComponent(this.name)}`, blob, { timeout: 30000 });
      this.media.poster = `${this.posterUrl}&t=${Date.now()}`;
    } catch { /* no picture: the dark card with a play button still works */ }
    v.removeAttribute('src');
    v.load();
  }

  input(kind) {
    if (kind !== 'tap') return;
    const v = this.media;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  setVisible(on) {
    super.setVisible(on);
    if (!on && !this.media.paused) this.media.pause();
  }

  get time() { return this.media.currentTime || 0; }

  destroy() {
    this.media.pause();
    this.media.removeAttribute('src');
    this.media.load();
  }
}

// A page shows once it has loaded: until then its holder is the board's paper colour (dark in dark
// mode) and the frame is invisible, so a card never flashes white before its page appears.
export function revealOnLoad(frame, holder) {
  holder.classList.add('loading');
  let done = false;
  const show = () => {
    if (done) return;
    done = true;
    holder.classList.remove('loading');
  };
  frame.addEventListener('load', show, { once: true });
  setTimeout(show, 10000); // a page that never says it loaded still shows
}

// ---- a live page in a sandboxed iframe (no access to the canvas or its key)
export function pageFrame(src, title) {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.title = title || 'Live page';
  f.src = src;
  return f;
}

// Talking to a live page (live-bridge.js inside it): messages wait until it says it's ready;
// input that arrives before then is dropped (it would land on a page that isn't there yet).
export class PageLink {
  constructor(frame, { onReady, onLink } = {}) {
    this.frame = frame;
    this.ready = false;
    this.queue = [];
    this._onMsg = (e) => {
      if (e.source !== frame.contentWindow || !e.data || e.data.canvas !== 1) return;
      if (e.data.type === 'ready') {
        this.ready = true;
        if (onReady) onReady();
        for (const m of this.queue.splice(0)) this.post(m);
      } else if (e.data.type === 'link' && typeof e.data.url === 'string' && /^https?:\/\//.test(e.data.url) && onLink) {
        onLink(e.data.url); // an outside link: it opens in the same card, as a live browser
      }
    };
    window.addEventListener('message', this._onMsg);
  }

  post(m) {
    const w = this.frame.contentWindow;
    if (!w || !this.ready) {
      if (m.type !== 'input') this.queue.push(m);
      return;
    }
    w.postMessage({ canvas: 1, ...m }, '*'); // its origin is opaque (sandboxed); nothing secret here
  }

  data(msg) { this.post({ type: 'data', data: msg.data, mode: msg.mode }); }

  reload(src) {
    this.ready = false;
    this.queue = this.queue.filter((m) => m.type === 'visibility');
    this.frame.src = `${src}?r=${Date.now()}`;
  }

  destroy() {
    window.removeEventListener('message', this._onMsg);
    this.frame.src = 'about:blank';
  }
}

class PageCard extends LiveCard {
  constructor(rec, root, opts) {
    super(rec, root, opts);
    const f = pageFrame(this.item.src, this.item.label);
    f.setAttribute('loading', 'lazy');
    this.frame = f;
    revealOnLoad(f, this.body);
    this.body.append(f);
    this.link = new PageLink(f, {
      onReady: () => this.link.post({ type: 'visibility', visible: this.visible }),
      onLink: (url) => this.opts.onLink && this.opts.onLink(this.rec, url),
    });
  }

  post(m) { this.link.post(m); }

  input(kind, x, y) {
    if (kind === 'tap') {
      this.post({ type: 'input', kind: 'down', x, y });
      this.post({ type: 'input', kind: 'up', x, y });
    } else this.post({ type: 'input', kind, x, y });
  }

  setVisible(on) {
    if (on === this.visible) return;
    super.setVisible(on);
    this.post({ type: 'visibility', visible: on });
  }

  data(msg) { this.link.data(msg); }

  reload() { this.link.reload(this.item.src); }

  destroy() { this.link.destroy(); }
}

// ---- a browser tab on the PC (browser.py): its newest picture, and the finger as touch input.
// Two picture requests are always in flight, so a new picture is on its way while one is shown
// and nothing queues up on a slow link. The picture's size and quality follow the link (measured
// on every picture) and the card's size on screen: small and light on cellular, sharp on Wi-Fi.
const STEP_W = [480, 640, 800, 960, 1280];
const STEP_Q = [30, 40, 50, 62];

export class BrowserStream {
  constructor(bid, img, { onMeta } = {}) {
    this.bid = bid;
    this.img = img;
    this.onMeta = onMeta;
    this.viewer = Math.random().toString(36).slice(2, 10);
    this.shown = 0;
    this.on = false;
    this.url = null;
    this.gen = 0;
    this.wi = 2;            // 800 px to start
    this.qi = 2;            // quality 50
    this.fitW = 1280;       // the card's width on screen, in device pixels
    this.rtt = 0;           // the link's round trip (ms)
    this.bps = 0;           // its bandwidth (bytes/s)
    this.avg = 0;           // recent picture size (bytes)
    this.changed = 0;
    this.lastMeta = '';
  }

  start() {
    if (this.on) return;
    this.on = true;
    const gen = ++this.gen;
    this._lane(gen, 0);
    this._lane(gen, 1);
  }

  stop() {
    this.on = false;
    this.gen++;
  }

  // the card's on-screen width in device pixels: no point fetching bigger pictures than that
  fit(px) {
    this.fitW = STEP_W.find((w) => w >= px) || STEP_W[STEP_W.length - 1];
  }

  get width() { return Math.min(STEP_W[this.wi], this.fitW); }

  async _lane(gen, lane) {
    if (lane) await new Promise((r) => setTimeout(r, 40));
    while (this.on && gen === this.gen) {
      const t0 = performance.now();
      try {
        const res = await fetch(withKey(`/api/browser/${encodeURIComponent(this.bid)}/frame?after=${this.shown}`
          + `&v=${this.viewer}&w=${this.width}&q=${STEP_Q[this.qi]}`), {
          headers: { 'X-Canvas-Key': KEY, 'X-Canvas-Session': SESSION }, cache: 'no-store' });
        if (gen !== this.gen) return;
        if (!res.ok) throw new Error(res.status);
        if ((res.headers.get('Content-Type') || '').startsWith('image/')) {
          const seq = +res.headers.get('X-Frame-Seq') || 0;
          const waited = +res.headers.get('X-Wait-Ms') || 0;
          const blob = await res.blob();
          if (gen !== this.gen) return;
          this._measure(blob.size, performance.now() - t0 - waited);
          if (seq > this.shown) this._show(seq, blob, res.headers);
        } else await res.json();
      } catch {
        await new Promise((r) => setTimeout(r, 1500)); // the PC or its Chrome is restarting
      }
      const wait = 90 - (performance.now() - t0); // two lanes: at most ~20 pictures a second
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  _show(seq, blob, headers) {
    this.shown = seq;
    const url = URL.createObjectURL(blob);
    const prev = this.url;
    this.url = url;
    this.img.src = url;
    if (prev) setTimeout(() => URL.revokeObjectURL(prev), 2000);
    const u = decodeURIComponent(headers.get('X-Browser-Url') || '');
    const t = decodeURIComponent(headers.get('X-Browser-Title') || '');
    if (this.onMeta && `${u}\n${t}` !== this.lastMeta) {
      this.lastMeta = `${u}\n${t}`;
      this.onMeta(u, t);
    }
  }

  // ms: from asking to having the whole picture, minus the time the PC waited for a new one
  _measure(bytes, ms) {
    if (ms <= 0) return;
    this.rtt = this.rtt ? Math.min(this.rtt * 1.03, ms) : ms; // the quickest recent trip
    const transfer = ms - this.rtt;
    if (bytes > 4000 && transfer > 8) {
      const bps = bytes / (transfer / 1000);
      this.bps = this.bps ? this.bps * 0.75 + bps * 0.25 : bps;
    } else if (bytes > 4000 && !this.bps) this.bps = 5e6; // arrived at once: a fast link
    this.avg = this.avg ? this.avg * 0.75 + bytes * 0.25 : bytes;
    const now = performance.now();
    if (!this.bps || now - this.changed < 2500) return;
    const budget = this.bps * 0.1; // a picture should take ~100 ms to arrive
    if (this.avg > budget) { // too heavy for this link: lighter first, then smaller
      if (this.qi > 0) this.qi--;
      else if (this.wi > 0) this.wi--;
      else return;
    } else if (this.avg < budget / 3) { // room to spare: bigger first (up to the card), then sharper
      if (this.wi < STEP_W.length - 1 && STEP_W[this.wi] < this.fitW) this.wi++;
      else if (this.qi < STEP_Q.length - 1) this.qi++;
      else return;
    } else return;
    this.changed = now;
    this.avg = 0;
  }

  // x, y in the shown picture's CSS px; (w, h) its size: mapped to the tab's own pixels
  send(kind, x, y, w, h, extra = {}) {
    const ev = { kind, x: (x / Math.max(1, w)) * BROWSER_W, y: (y / Math.max(1, h)) * BROWSER_H, ...extra };
    api.post(`/api/browser/${encodeURIComponent(this.bid)}/input`, ev).catch(() => {});
  }

  destroy() {
    this.stop();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

class BrowserCard extends LiveCard {
  constructor(rec, root, opts) {
    super(rec, root, opts);
    this.bar.insertBefore(Object.assign(document.createElement('span'), { className: 'dot' }), this.bar.firstChild.nextSibling);
    this.browsing = !!this.item.browsing; // a page card following one of its links
    if (this.browsing) {
      const back = Object.assign(document.createElement('span'), { className: 'back', textContent: '‹' });
      this.bar.insertBefore(back, this.bar.firstChild);
    }
    const img = document.createElement('img');
    img.className = 'frame';
    img.alt = '';
    img.draggable = false;
    const wait = document.createElement('div');
    wait.className = 'wait';
    wait.textContent = 'Opening…';
    this.body.append(img, wait);
    this.stream = new BrowserStream(this.browsing ? this.item.browsing.browser : this.item.browser, img, {
      onMeta: (url, title) => {
        wait.remove();
        this.setTitle(this.item.label || title || hostOf(url));
      },
    });
    this.lastMove = 0;
  }

  input(kind, x, y) {
    if (this.browsing && kind === 'tap' && y < 0 && x < BACK_W) { // ‹ in the strip: back to the page
      if (this.opts.onBack) this.opts.onBack(this.rec);
      return;
    }
    if (kind === 'tap') {
      this.stream.send('down', x, y, this.cw, this.ch);
      this.stream.send('up', x, y, this.cw, this.ch);
    } else if (kind === 'move') {
      const now = performance.now();
      if (now - this.lastMove < 33) return; // ~30 a second is plenty for scrolling
      this.lastMove = now;
      this.stream.send('move', x, y, this.cw, this.ch);
    } else if (kind === 'down' || kind === 'up') this.stream.send(kind, x, y, this.cw, this.ch);
    else if (kind === 'cancel') this.stream.send('up', x, y, this.cw, this.ch);
  }

  setVisible(on) {
    super.setVisible(on);
    if (on) {
      this.stream.fit(this.rec.host.getBoundingClientRect().width * (window.devicePixelRatio || 1));
      this.stream.start();
    } else this.stream.stop();
  }

  destroy() { this.stream.destroy(); }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || 'Browser'; }
}

export function makeLiveCard(rec, root, opts = {}) {
  root.append(Object.assign(document.createElement('style'), { textContent: LIVE_STYLE }));
  const K = rec.item.type === 'page' && rec.item.browsing ? BrowserCard
    : { video: VideoCard, page: PageCard, browser: BrowserCard }[rec.item.type];
  return new K(rec, root, opts);
}
