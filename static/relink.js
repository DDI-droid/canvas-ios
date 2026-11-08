// Following the canvas server when its address changes (see canvas/supervisor.py).
//
// The PC runs the canvas behind a free Cloudflare tunnel whose address changes whenever the
// tunnel restarts. supervisor.py publishes every new address to a secret GitHub gist (the
// address only, never the key), and each poll tells the page where that gist is. When the
// server stops answering for a few seconds, the page reads the gist; if the canvas moved, it
// follows. Inside the iPad app, the app loads the new address (it keeps this page's settings
// in its own storage). In Safari, the page moves itself and carries its settings and unsent
// ink along in the URL fragment, because the browser keeps storage per address.
import { snapshotStore, store } from './util.js';

const KEY = 'registry';
const FILE = 'canvas-link.json';
const REGISTRY_RE = /^https:\/\/api\.github\.com\/gists\/[0-9a-f]{8,64}$/;
let told = '';
let lastTry = 0;

// Every poll says where the gist is: remember it here and in the app.
export function rememberRegistry(url) {
  if (typeof url !== 'string' || !REGISTRY_RE.test(url) || url === told) return;
  told = url;
  if (store.get(KEY, null) !== url) store.set(KEY, url);
  window.__canvasNative?.post('registry', { url });
}

// Where the canvas is now, according to the gist (an origin), or null.
async function lookup() {
  const registry = store.get(KEY, null);
  if (!registry || !REGISTRY_RE.test(registry)) return null;
  try {
    const res = await fetch(`${registry}?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const gist = await res.json();
    const info = JSON.parse((gist.files && gist.files[FILE] && gist.files[FILE].content) || '{}');
    const u = new URL(info.url);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

// The server hasn't answered for a while: if the canvas moved, go there. Returns true if we're
// leaving. At most one look every 20 s (GitHub allows 60 unauthenticated lookups an hour).
export async function followIfMoved() {
  if (Date.now() - lastTry < 20000) return false;
  lastTry = Date.now();
  const origin = await lookup();
  if (!origin || origin === location.origin) return false; // same place: the PC itself is down
  store.keepAll(); // unsent ink goes to the app's storage too, before we leave
  if (window.__canvasNative) {
    window.__canvasNative.post('relink', { origin });
    return true;
  }
  let hash = '';
  try {
    const packed = btoa(unescape(encodeURIComponent(JSON.stringify(snapshotStore()))));
    if (packed.length < 1500000) hash = `#carry=${packed}`;
  } catch { /* too big or odd characters: settings start fresh, ink is on the server */ }
  location.replace(origin + location.pathname + location.search + hash);
  return true;
}
