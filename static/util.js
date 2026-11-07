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

const NS = 'canvas.';
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(NS + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(NS + key); } catch { /* ignore */ }
  },
};

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
