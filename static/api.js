// Auth token handling, JSON API calls and the Server-Sent Events connection.
import { store } from './util.js';
import { followIfMoved, rememberRegistry } from './relink.js';

function resolveKey() {
  const params = new URLSearchParams(location.search);
  let k = params.get('k');
  if (k) {
    store.set('k', k);
    return k;
  }
  k = store.get('k', '');
  if (k) return k;
  const meta = document.querySelector('meta[name="canvas-key"]')?.content || '';
  return meta.includes('%%') ? '' : meta;
}

export const KEY = resolveKey();

// Which canvas session (board + chat) this page shows: ?s=, else the last one used, else main.
// Each Claude session (local, another machine, or cloud) owns one; see /agent.
const SESSION_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
function resolveSession() {
  const s = (new URLSearchParams(location.search).get('s') || '').trim().toLowerCase();
  if (SESSION_RE.test(s)) {
    store.set('session', s);
    return s;
  }
  const saved = store.get('session', 'main');
  return SESSION_RE.test(saved) ? saved : 'main';
}

export const SESSION = resolveSession();

// localStorage keys that belong to one board (camera, offline strokes, ...)
export const sessionKey = (k) => (SESSION === 'main' ? k : `${k}:${SESSION}`);

export function switchSession(id) {
  store.set('session', id);
  const u = new URL(location.href);
  u.searchParams.set('s', id);
  location.replace(u.toString());
}

export function withKey(url) {
  if (!url) return url;
  const sep = url.includes('?') ? '&' : '?';
  const s = /[?&]s=/.test(url) ? '' : '&s=' + encodeURIComponent(SESSION);
  return url + sep + 'k=' + encodeURIComponent(KEY) + s;
}

async function request(method, path, body, { timeout = 30000, type } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const opts = { method, headers: { 'X-Canvas-Key': KEY, 'X-Canvas-Session': SESSION }, cache: 'no-store', signal: ctl.signal };
  if (body instanceof Blob) { // a file as it is (images): no base64, no JSON
    opts.headers['Content-Type'] = type || body.type || 'application/octet-stream';
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* not json */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b ?? {}, o),
  put: (p, b, o) => request('PUT', p, b, o),
};

// Long-polling event stream. (EventSource/SSE is buffered by Cloudflare quick
// tunnels, so events never reached the iPad.) Same interface as before: dispatches
// 'state' plus one CustomEvent per server event type, and 'hello' on (re)sync.
export class EventStream extends EventTarget {
  constructor() {
    super();
    this.path = '/api/poll';
    this.since = -1;
    this.epoch = '';
    this.state = 'idle';
    this.gen = 0;
    this.ctl = null;
    this.backoff = 1000;
    this.quick = true; // next request answers at once: confirms the link fast after (re)connecting
    // iOS suspends the page in the background (the app minimised), and its in-flight request
    // usually dies with no error. Restart the poll on any sign that we're back...
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(); });
    window.addEventListener('pageshow', () => this.kick());
    window.addEventListener('online', () => this.kick());
    window.addEventListener('focus', () => { if (this.state !== 'open') this.kick(); });
    // ...including the one iOS can't hide: a timer that skipped ahead means we were frozen.
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      if (now - last > 6000) this.kick();
      last = now;
    }, 2000);
  }

  // Start from the cursor that came with a state snapshot (GET /api/state), so nothing that
  // happens between loading the page and the first poll is missed.
  resume(cursor) {
    if (!cursor || this.epoch || typeof cursor.epoch !== 'string' || !Number.isFinite(cursor.seq)) return;
    this.epoch = cursor.epoch;
    this.since = cursor.seq;
  }

  connect() {
    if (this.state !== 'open') this._set('connecting');
    this.quick = true;
    const gen = ++this.gen;
    this._loop(gen);
  }

  kick() {
    if (this.ctl) this.ctl.abort();
    this.backoff = 1000;
    this.connect();
  }

  async _loop(gen) {
    while (gen === this.gen) {
      const ctl = new AbortController();
      this.ctl = ctl;
      const quick = this.quick;
      // a quick check must answer within 8 s, or the connection is dead: drop it and retry
      const timer = setTimeout(() => ctl.abort(), quick ? 8000 : 40000);
      try {
        const qs = `since=${this.since}&epoch=${encodeURIComponent(this.epoch)}&wait=${quick ? 0 : 25}`;
        const res = await fetch(withKey(`${this.path}?${qs}`), {
          headers: { 'X-Canvas-Key': KEY },
          cache: 'no-store',
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (gen !== this.gen) return;
        this.backoff = 1000;
        this.quick = false;
        this.failingSince = 0;
        this._set('open');
        if (body.registry) rememberRegistry(body.registry);
        if (body.sessions) this._emit('sessions', body.sessions);
        if (body.build) this._emit('build', body.build);
        if (body.app) this._emit('app', body.app);
        if (body.reset) {
          this.epoch = body.epoch;
          this.since = body.next;
          this._emit('hello', { status: body.status });
          if (body.status) this._emit('status', body.status);
        } else {
          for (const ev of body.events || []) {
            if (ev.seq <= this.since) continue;
            this.since = ev.seq;
            this._emit(ev.event, ev.data);
          }
          this.since = Math.max(this.since, body.next);
        }
      } catch (err) {
        if (gen !== this.gen) return;
        this._set('reconnecting');
        this.quick = true;
        // still failing after a few seconds: maybe the canvas moved to a new address
        this.failingSince = this.failingSince || Date.now();
        if (Date.now() - this.failingSince > 6000) followIfMoved().catch(() => {});
        await new Promise((r) => setTimeout(r, this.backoff * (0.85 + Math.random() * 0.3)));
        this.backoff = Math.min(this.backoff * 2, 15000);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  _emit(type, data) {
    this.dispatchEvent(new CustomEvent(type, { detail: data }));
  }

  _set(state) {
    if (state === this.state) return;
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: state }));
  }
}
