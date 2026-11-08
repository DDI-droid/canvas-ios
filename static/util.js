// Small shared helpers.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function uid(prefix = '') {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return prefix + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Settings and offline data (localStorage, under "canvas.").
//
// The browser keeps localStorage per address, and the canvas's address can change (relink.js).
// So inside the iPad app every value is also kept by the app: it hands each page load a copy
// (window.__canvasNativeStore), and a key missing here is read from that copy. In Safari, the
// page carries its values to the new address itself (#carry=, below).
const NS = 'canvas.';
const LAZY = /^(pending(Strokes|Ink)|outbox)/; // short-lived, written often: given to the app only when it matters
const toApp = (key, raw) => {
  try { window.__canvasNative && window.__canvasNative.post('store', { key, value: raw }); } catch { /* ignore */ }
};
export const store = {
  get(key, fallback) {
    try {
      let v = localStorage.getItem(NS + key);
      if (v == null) {
        const copy = window.__canvasNativeStore;
        if (copy && typeof copy[key] === 'string') {
          v = copy[key];
          try { localStorage.setItem(NS + key, v); } catch { /* full: still use it */ }
        }
      }
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      const raw = JSON.stringify(value);
      localStorage.setItem(NS + key, raw);
      if (!LAZY.test(key)) toApp(key, raw);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(NS + key); } catch { /* ignore */ }
    toApp(key, null);
  },
  // give a big value (unsent ink) to the app too: a save failed, or we're about to move
  keep(key) {
    try {
      const raw = localStorage.getItem(NS + key);
      if (raw != null) toApp(key, raw);
    } catch { /* ignore */ }
  },
  keepAll() {
    for (const k of Object.keys(snapshotStore())) if (LAZY.test(k)) this.keep(k);
  },
};

// Every canvas value on this page, raw (Safari carries these to the new address).
export function snapshotStore() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) out[k.slice(NS.length)] = localStorage.getItem(k);
    }
  } catch { /* storage unavailable */ }
  return out;
}

// Arriving from the canvas's old address (relink.js, Safari): take its values over, keeping any
// this address already has, then drop the fragment from the address bar.
(function importCarried() {
  try {
    const m = /#carry=([A-Za-z0-9+/=]+)/.exec(location.hash);
    if (!m) return;
    const data = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && localStorage.getItem(NS + k) == null) localStorage.setItem(NS + k, v);
    }
    history.replaceState(null, '', location.pathname + location.search);
  } catch { /* ignore */ }
})();

export function debounce(fn, ms) {
  let t = 0;
  let pendingArgs = null;
  const run = () => {
    t = 0;
    const args = pendingArgs;
    pendingArgs = null;
    if (args) fn(...args);
  };
  const d = (...args) => {
    pendingArgs = args;
    clearTimeout(t);
    t = setTimeout(run, ms);
  };
  d.flush = () => {
    if (t) {
      clearTimeout(t);
      run();
    }
  };
  d.cancel = () => {
    clearTimeout(t);
    t = 0;
    pendingArgs = null;
  };
  return d;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtClock(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function rectsIntersect(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function unionRect(a, b) {
  if (!a) return b ? b.slice() : null;
  if (!b) return a.slice();
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export const isIOS = /iP(ad|hone|od)/.test(navigator.platform) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
