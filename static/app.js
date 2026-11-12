// Canvas — app wiring: board + Claude layer + chat overlay + voice + server sync.
import { Board } from './board.js';
import { ClaudeLayer } from './claude-layer.js';
import { ChatPanel } from './chat.js';
import { Voice, voiceSupported } from './voice.js';
import { Live, rankVoices } from './live.js';
import { Viewer } from './viewer.js';
import { Cards } from './cards.js';
import { InkSync } from './inksync.js';
import { BAR, BrowserStream, PageLink, pageFrame, revealOnLoad } from './livecards.js';
import { buildSnapshot, buildTimeline, makeThumb } from './snapshot.js';
import { api, EventStream, KEY, SESSION, sessionKey, setSession, switchSession, withKey } from './api.js';
import { COLORS, inkColor } from './palette.js';
import { hydrateIcons, icon } from './icons.js';
import { confirmSheet, hud, lightbox, popover, toast } from './ui.js';
import { $, $$, debounce, rectsIntersect, store, uid } from './util.js';
import { cacheStats } from './inkcache.js';

const T_CODE = performance.now(); // every module has loaded and run: the start-up report's "code"
const CLIENT_ID = uid('c');
const THEME_COLOR = { light: '#f8f6f1', dark: '#1a1a1c' };

const prefs = Object.assign(
  { theme: null, paper: 'dots', voiceName: '', fingerDraw: false, lang: 'en-US', layer: true, mode: 'view', tool: 'pen',
    color: { pen: 'ink', hl: 'yellow' }, width: { pen: 1, hl: 1, eraser: 1 } },
  store.get('prefs', {}),
);
const savePrefs = () => store.set('prefs', prefs);

const app = $('#app');
hydrateIcons();

// ------------------------------------------------------------------ core objects

const board = new Board({
  root: $('#board'),
  paper: $('#paper'),
  ink: $('#ink'),
  live: $('#live'),
  selection: $('#selection'),
  hover: $('#hover'),
});
const layer = new ClaudeLayer($('#claudeLayer'));
// a page card's outside link: the card browses it (same card); ‹ comes back to the page
async function browseInCard(rec, url, fullScreen) {
  try {
    const res = await api.post('/api/card/browse', { id: rec.item.id, url }, { timeout: 60000 });
    if (res && res.item) layer.upsert(res.item, { animate: false });
    if (fullScreen && viewer.isOpen) {
      viewer.close();
      setTimeout(() => openMedia(rec.item.id), 480);
    }
  } catch (err) {
    toast(`Couldn’t open that link: ${err.message}`, { tone: 'error' });
  }
}
async function backToPage(id) {
  try {
    const res = await api.post('/api/card/back', { id });
    if (res && res.item) layer.upsert(res.item, { animate: false });
  } catch { /* the next refresh shows it */ }
}
layer.liveOpts = {
  onLink: (rec, url) => browseInCard(rec, url, false),
  onBack: (rec) => backToPage(rec.item.id),
  // a video placed with a guessed shape (an agent's upload): fix it to the real one, for everyone
  onAspect: (rec, aspect) => {
    const height = rec.w * aspect + BAR;
    if (Math.abs(height - rec.h) < 2) return;
    const g = { x: rec.item.x, y: rec.item.y, width: rec.w, height };
    layer.place(rec.item.id, g);
    api.post('/api/draw/move', { id: rec.item.id, ...g }).catch(() => {});
  },
};
// cards: tap to select, drag to move, corners to resize (same for every kind of card)
const cards = new Cards({
  board,
  layer,
  el: $('#cardSel'),
  onCommit: (id, g) => {
    layer.sharpen(board.cam, board.viewRect(), board.dpr); // resized bigger: maybe the full image now
    api.post('/api/draw/move', { id, ...g }).catch((err) => {
      if (err.status !== 404) toast('Couldn’t save the new place. It may jump back after a reload.', { tone: 'error' });
    });
  },
  onOpen: (id) => openMedia(id),
  onRemove: async (id) => {
    layer.remove(id);
    try {
      await api.post('/api/draw/remove', { id });
    } catch (err) {
      if (err.status !== 404) toast('Couldn’t remove it on the server.', { tone: 'error' });
    }
  },
});
board.cardHooks = cards;
// automated tests only (?debug in the URL): reach the board from the outside
if (new URLSearchParams(location.search).has('debug')) window.__canvas = { board, layer, cards };
// the "Draw with Pencil · …" hint is for an empty board only
layer.addEventListener('change', () => { if (layer.count) hideHint(); });
const chat = new ChatPanel();
const voice = new Voice(prefs.lang);
const events = new EventStream('/api/events');

let lastSendAt = store.get(sessionKey('lastSendAt'), 0);
let sending = false;
// Messages not yet delivered are kept in storage until the server has them, so a reload (or
// the app moving to a new address) doesn't lose what you sent while the link was down. The
// server ignores a message it already has (same cid), so re-sending is always safe.
const outbox = new Map(Object.entries(store.get(sessionKey('outbox'), {}) || {}));
function saveOutbox() {
  const key = sessionKey('outbox');
  if (!outbox.size) return store.remove(key);
  if (!store.set(key, Object.fromEntries(outbox))) {
    // too big for this page's storage: keep the words and the timeline, drop the pictures
    store.set(key, Object.fromEntries([...outbox].map(([k, v]) => [k, { ...v, image: null }])));
  }
  store.keep(key);
}

// ------------------------------------------------------------------ theme

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', THEME_COLOR[theme]);
  board.setTheme(theme);
  syncMenu();
  refreshToolbar();
}
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const initialTheme = () => prefs.theme || (systemDark.matches ? 'dark' : 'light');
systemDark.addEventListener?.('change', () => { if (!prefs.theme) applyTheme(initialTheme()); });

// ------------------------------------------------------------------ toolbar

const swatchHost = $('#swatches');
const paletteGrid = $('#paletteGrid');
for (const host of [swatchHost, paletteGrid]) {
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = c.key;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c.name);
    b.title = c.name[0].toUpperCase() + c.name.slice(1);
    b.innerHTML = '<span class="chip"></span>';
    host.appendChild(b);
  }
}
const palettePop = popover($('#palettePop'), $('#btnColor'));

function refreshSwatchColors() {
  const theme = board.theme;
  for (const b of $$('.swatch')) {
    const key = b.dataset.color;
    b.style.setProperty('--c', board.tool === 'hl' ? inkColor(key, theme, true) : inkColor(key, theme));
  }
}

function moveToolIndicator() {
  const on = $(`.tool[data-tool="${board.tool}"]`);
  if (on) $('#toolInd').style.transform = `translateX(${on.offsetLeft}px)`;
}

function refreshToolbar() {
  const tool = board.tool;
  for (const b of $$('.tool')) {
    const on = b.dataset.tool === tool;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  moveToolIndicator();
  refreshSwatchColors();
  const colorKey = board.activeColor;
  const showColor = tool === 'pen' || tool === 'hl';
  for (const b of $$('.swatch')) {
    const on = showColor && b.dataset.color === colorKey;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  const c = inkColor(colorKey, board.theme, tool === 'hl');
  $('#btnColor').style.setProperty('--c', showColor ? c : 'var(--fg-4)');
  const wb = $('#btnWidth');
  wb.dataset.w = String(board.widthIdx[board.widthFamily]);
  wb.style.setProperty('--c', showColor ? c : 'var(--fg)');
  $('#btnUndo').disabled = !board.canUndo;
  $('#btnRedo').disabled = !board.canRedo;
}

function setTool(tool) {
  board.setTool(tool);
  prefs.tool = board.tool;
  savePrefs();
}

// Apple Pencil taps on buttons. iPad WebKit turns a tap into a click only when its tap gesture
// recognises it, and it often misses short Pencil taps: tool buttons did nothing with the Pencil
// while fingers worked. So on a pen tap (down and up on the same button, barely moving) we press
// the button ourselves, and swallow the click WebKit may still send right after (no double press).
{
  let down = null;
  let pressed = null;
  let pressedAt = 0;
  const buttonAt = (e) => (e.target instanceof Element ? e.target.closest('button') : null);
  document.addEventListener('pointerdown', (e) => {
    const b = e.pointerType === 'pen' ? buttonAt(e) : null;
    down = b && !b.disabled ? { b, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
  }, true);
  document.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || e.pointerType !== 'pen' || e.pointerId !== d.id || buttonAt(e) !== d.b) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12 || performance.now() - d.t > 700) return;
    pressed = d.b;
    pressedAt = performance.now();
    d.b.click();
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !pressed || performance.now() - pressedAt > 600) return;
    if (e.target instanceof Node && pressed.contains(e.target)) {
      e.stopImmediatePropagation();
      e.preventDefault();
      pressed = null;
    }
  }, true);
}

$('#toolbar').addEventListener('click', (e) => {
  const t = e.target.closest('.tool');
  if (t) return setTool(t.dataset.tool);
  const s = e.target.closest('.swatch');
  if (s) {
    board.setColor(s.dataset.color);
    prefs.color = { ...board.color };
    savePrefs();
    return;
  }
  if (e.target.closest('#btnWidth')) {
    board.cycleWidth();
    prefs.width = { ...board.widthIdx };
    savePrefs();
    return;
  }
  if (e.target.closest('#btnUndo')) return board.undo();
  if (e.target.closest('#btnRedo')) return board.redo();
});
paletteGrid.addEventListener('click', (e) => {
  const s = e.target.closest('.swatch');
  if (!s) return;
  board.setColor(s.dataset.color);
  prefs.color = { ...board.color };
  savePrefs();
  setTimeout(() => palettePop.close(), 120);
});

$('#selection').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sel]');
  if (!b) return;
  if (b.dataset.sel === 'delete') board.deleteSelection();
  else if (b.dataset.sel === 'duplicate') board.duplicateSelection();
});

// ------------------------------------------------------------------ board events

const saveCam = debounce(() => store.set(sessionKey('cam'), board.cam), 400);
board.addEventListener('tool', refreshToolbar);
board.addEventListener('history', refreshToolbar);
board.addEventListener('hud', (e) => hud(e.detail.text, e.detail.icon));
board.addEventListener('view', (e) => {
  layer.sync(e.detail);
  cards.sync();
});
let zoomPct = 100;
board.addEventListener('camera', (e) => {
  const pct = Math.round(e.detail.z * 100);
  if (pct !== zoomPct) { // only touch the toolbar when the number changes (not on every pan frame)
    zoomPct = pct;
    $('#zoomLabel').textContent = `${pct}%`;
  }
  saveCam();
});
// zoomed in on a photo card: show its full image rather than the light preview
const sharpenCards = () => layer.sharpen(board.cam, board.viewRect(), board.dpr);
board.addEventListener('settle', sharpenCards);
// live cards run while on screen and rest off it (pages paused, browsers not fetching, video paused)
let liveCheck = 0;
const updateLiveCards = () => {
  cancelAnimationFrame(liveCheck);
  liveCheck = requestAnimationFrame(() => layer.updateVisibility(board.viewRect()));
};
board.addEventListener('settle', updateLiveCards);
layer.addEventListener('change', updateLiveCards);
document.addEventListener('visibilitychange', updateLiveCards);
board.addEventListener('change', (e) => {
  if (e.detail.local) {
    ink.local(); // send just what changed
    hideHint();
  }
  updateInkChip();
  updateSendReady();
});
board.addEventListener('fingerdraw', () => {
  prefs.fingerDraw = false;
  savePrefs();
  $('#optFinger').checked = false;
  toast('Apple Pencil detected — finger drawing is off. Fingers now pan and zoom.');
});
// ---- media cards: a finger double-tap opens one full screen (the Pencil keeps drawing over them)
const viewer = new Viewer($('#stage'));
let stagePage = null; // the live page open full screen: {page, src, link}
let stageId = null;   // the card open full screen

function openMedia(id) {
  const rec = layer.records.get(id);
  if (!rec || (rec.kind !== 'image' && !rec.live)) return false;
  cards.clear();
  const base = {
    title: rec.item.label || (rec.live ? rec.live.titleEl.textContent : '') || '',
    from: () => rec.host.getBoundingClientRect(),
    onHide: (hidden) => {
      rec.host.style.visibility = hidden ? 'hidden' : '';
      stageId = hidden ? id : null;
      if (!rec.live) return;
      // full screen runs its own copy: the card rests meanwhile (no double rendering or fetching)
      layer.focused = hidden ? id : null;
      if (!hidden) stagePage = null;
      updateLiveCards();
    },
  };
  if (rec.kind === 'image') {
    viewer.show({ ...base, src: withKey(rec.item.src), aspect: rec.h / rec.w });
    return true;
  }
  const aspect = (rec.h - BAR) / rec.w;
  if (rec.kind === 'browser' || (rec.kind === 'page' && rec.item.browsing)) {
    viewer.show({ ...base, kind: 'browser', aspect, mount: (frame) => mountBrowser(frame, rec) });
  } else if (rec.kind === 'video') {
    const card = rec.live.media;
    const t = card.currentTime || 0;
    card.pause();
    viewer.show({ ...base, kind: 'video', aspect, mount: (frame) => {
      const v = document.createElement('video');
      Object.assign(v, { controls: true, playsInline: true, autoplay: true, className: 'stage-media', poster: card.poster });
      v.setAttribute('playsinline', '');
      v.src = withKey(rec.item.src);
      v.addEventListener('loadedmetadata', () => { if (t) v.currentTime = t; v.play().catch(() => {}); }, { once: true });
      frame.append(v);
      return { destroy: () => { try { card.currentTime = v.currentTime; } catch { /* not loaded */ } v.pause(); v.removeAttribute('src'); v.load(); } };
    } });
  } else if (rec.kind === 'page') {
    viewer.show({ ...base, kind: 'page', aspect, mount: (frame) => {
      const f = pageFrame(rec.item.src, rec.item.label);
      f.className = 'stage-media';
      revealOnLoad(f, frame);
      frame.append(f);
      const link = new PageLink(f, {
        onReady: () => link.post({ type: 'visibility', visible: true }),
        onLink: (u) => browseInCard(rec, u, true),
      });
      stagePage = { page: rec.item.page, src: rec.item.src, link }; // live data reaches it too
      return { destroy: () => { if (stagePage && stagePage.link === link) stagePage = null; link.destroy(); } };
    } });
  }
  return true;
}

// A browser card full screen: the tab's picture (the finger is the tab's touch: taps click,
// drags scroll), and in the top bar: back, forward, reload, the address, and a box to type into
// the page (tap a field in the page first, type, Return).
function mountBrowser(frame, rec) {
  const img = document.createElement('img');
  img.className = 'stage-media';
  img.alt = '';
  img.draggable = false;
  frame.append(img);
  const tools = document.createElement('div');
  tools.className = 'stage-tools';
  tools.innerHTML = (rec.item.browsing ? '<button class="st-btn st-page" data-b="page" aria-label="Back to the page">Page</button>' : '')
    + '<button class="st-btn" data-b="back" aria-label="Back">‹</button>'
    + '<button class="st-btn" data-b="forward" aria-label="Forward">›</button>'
    + '<button class="st-btn" data-b="reload" aria-label="Reload">↻</button>'
    + '<input class="st-url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Address or search">'
    + '<input class="st-type" type="text" autocapitalize="off" placeholder="Type into the page, then Return">';
  const bar = viewer.root.querySelector('.stage-bar');
  bar.insertBefore(tools, viewer.closeBtn);
  const url = tools.querySelector('.st-url');
  const typer = tools.querySelector('.st-type');
  const stream = new BrowserStream(rec.item.browsing ? rec.item.browsing.browser : rec.item.browser, img, {
    onMeta: (u) => { if (document.activeElement !== url && u) url.value = u; },
  });
  stream.fit(Math.min(window.innerWidth, 1400) * (window.devicePixelRatio || 1));
  stream.start();
  const send = (kind, extra) => stream.send(kind, 0, 0, 1, 1, extra);
  tools.addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]');
    if (!b) return;
    if (b.dataset.b === 'page') { // back to the page this card was showing
      viewer.close();
      backToPage(rec.item.id);
      return;
    }
    send(b.dataset.b);
  });
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && url.value.trim()) { send('nav', { url: url.value.trim() }); url.blur(); }
  });
  typer.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (typer.value) send('text', { text: typer.value });
    send('key', { key: 'Enter' });
    typer.value = '';
  });
  let down = false, last = 0;
  const pos = (e) => { const r = img.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, r.width, r.height]; };
  img.addEventListener('pointerdown', (e) => {
    down = true;
    img.setPointerCapture(e.pointerId);
    stream.send('down', ...pos(e));
  });
  img.addEventListener('pointermove', (e) => {
    if (!down || performance.now() - last < 33) return;
    last = performance.now();
    stream.send('move', ...pos(e));
  });
  const up = (e) => { if (!down) return; down = false; stream.send('up', ...pos(e)); };
  img.addEventListener('pointerup', up);
  img.addEventListener('pointercancel', up);
  return { destroy: () => { stream.destroy(); tools.remove(); } };
}
board.onDoubleTap = ({ wx, wy }) => {
  const id = layer.hitTest(wx, wy, 6 / board.cam.z);
  return id ? openMedia(id) : false;
};

// A photo as it should be uploaded: as it is when it's reasonable (screenshots keep every
// pixel), else scaled to MAX_SIDE on its long side as a high-quality JPEG. That's still plenty
// for zooming into detail in full screen, and a fraction of a 48 MP photo's upload and memory.
const MAX_SIDE = 4096;
async function prepareImage(file) {
  let bmp = null;
  try { bmp = await createImageBitmap(file); } catch { /* can't decode here: send it as it is */ }
  if (!bmp) return { blob: file, aspect: 0.66 };
  const w = bmp.width, h = bmp.height, aspect = h / w, long = Math.max(w, h);
  if (long <= MAX_SIDE && file.size <= 12e6 && /^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
    bmp.close();
    return { blob: file, aspect };
  }
  const k = Math.min(1, MAX_SIDE / long);
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
  c.width = c.height = 0; // free it now (iOS keeps a tight canvas budget)
  return { blob: blob || file, aspect };
}

// + : add images from Photos / Files. Each is uploaded to the canvas server and placed in view.
$('#btnAdd').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  let i = 0;
  for (const file of files) {
    const kind = fileKind(file);
    if (!kind) { toast(`${file.name}: images, videos and 3D models (glb, gltf, obj, stl) only.`, { tone: 'error' }); continue; }
    try {
      const v = board.viewRect();
      const vw = v[2] - v[0], vh = v[3] - v[1];
      const label = file.name && !/^(image|video|IMG_\d+|trim\.[\w-]+)\.\w+$/i.test(file.name) ? file.name.replace(/\.[^.]+$/, '') : '';
      // its size here; the server puts it in the middle of this view, or the nearest free spot
      const place = (aspect, share = 0.42, bar = 0) => {
        let width = vw * share;
        if (width * aspect + bar > vh * 0.75) width = (vh * 0.75 - bar) / aspect;
        return { width, view: v };
      };
      if (kind === 'image') {
        if (file.size > 60 * 1024 * 1024) throw new Error('too big (max 60 MB)');
        const { blob, aspect } = await prepareImage(file);
        const up = await api.post('/api/media', blob, { timeout: 120000 });
        await api.post('/api/draw', { type: 'image', src: up.src, aspect, label, ...place(aspect) });
      } else if (kind === 'video') {
        toast(`Uploading ${file.name}…`, { ms: 4000 });
        const { aspect, poster } = await probeVideo(file);
        const up = await api.post('/api/media', file, { type: videoType(file), timeout: 30 * 60000 });
        if (poster) await api.post(`/api/media/poster?for=${encodeURIComponent(up.src.split('/').pop())}`, poster).catch(() => {});
        await api.post('/api/draw', { type: 'video', src: up.src, aspect, label, ...place(aspect, 0.42, BAR) });
      } else {
        const up = await api.post('/api/media', file, { type: modelType(file), timeout: 600000 });
        const page = await api.post('/api/page', { template: 'model', data: { src: `media/${up.src.split('/').pop()}` }, title: label });
        await api.post('/api/draw', { type: 'page', page: page.page, aspect: 0.75, label: label || '3D model', ...place(0.75, 0.42, BAR) });
      }
      i++;
    } catch (err) {
      toast(`Couldn’t add ${file.name || 'that file'}: ${err.message}`, { tone: 'error' });
    }
  }
  if (i) toast(i === 1 ? 'Added. Double-tap it to open full screen.' : `${i} added.`);
});

function fileKind(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(file.name)) return 'video';
  if (/\.(glb|gltf|obj|stl)$/i.test(file.name)) return 'model';
  return null;
}
function videoType(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return { mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v' }[ext] || (file.type.startsWith('video/') ? file.type : 'video/mp4');
}
function modelType(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return { glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', stl: 'model/stl' }[ext];
}
// A video's shape and first frame, read here before uploading (no server-side tools needed).
async function probeVideo(file) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  const url = URL.createObjectURL(file);
  v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(rej, 15000); });
    const aspect = v.videoWidth ? v.videoHeight / v.videoWidth : 0.5625;
    v.currentTime = Math.min(0.5, (v.duration || 1) / 10);
    await new Promise((res) => { v.onseeked = res; setTimeout(res, 3000); });
    const k = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * k);
    c.height = Math.round(v.videoHeight * k);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const poster = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    c.width = c.height = 0;
    return { aspect, poster };
  } catch {
    return { aspect: 0.5625, poster: null };
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

// tell the server where you're looking, so agents and the voice place things in view
const reportView = debounce(() => {
  api.post('/api/view', { view: board.viewRect() }).catch(() => {});
}, 800);
board.addEventListener('camera', reportView);
setTimeout(reportView, 1500);

// a long-press on a card selects it and picks it up (keep moving to drag it)
board.onLongPress = ({ wx, wy }) => {
  const id = layer.hitTest(wx, wy, 8 / board.cam.z);
  if (!id) return false;
  cards.select(id);
  return 'card';
};

function updateInkChip() {
  chat.setNewInk(board.strokesSince(lastSendAt).length);
}

// ------------------------------------------------------------------ persistence of ink

// Ink goes to the server as changes (inksync.js): a stroke is a few KB, not the whole board.
const ink = new InkSync({ board, clientId: CLIENT_ID });
ink.addEventListener('trouble', () => toast('Can’t reach the server — your ink is kept on this device and will sync.', { tone: 'error' }));
ink.addEventListener('recovered', () => toast('Ink saved.'));
if (new URLSearchParams(location.search).has('debug')) window.__canvas.ink = ink;

// A page from before this version may have left a whole-board backup that never reached the
// server: send it once the old way (it replaces the board, as it would have), then forget it.
async function sendLegacyBackup() {
  const key = sessionKey('pendingStrokes');
  const raw = store.get(key, null);
  if (!raw) return false;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed.strokes)) await api.put('/api/strokes', { strokes: parsed.strokes, client: CLIENT_ID }, { timeout: 45000 });
    store.remove(key);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ hint

let hintShown = false;
function showHint() {
  hintShown = true;
  $('#hint').classList.remove('gone');
}
function hideHint() {
  if (!hintShown) return;
  hintShown = false;
  $('#hint').classList.add('gone');
}

// ------------------------------------------------------------------ voice

const micBtn = $('#btnMic');
let level = 0;
let lastHeard = 0;
let levelRaf = 0;
const bars = $$('.mic-bars i', micBtn);

function setMicIcon(name) {
  const holder = micBtn.querySelector('.mic-ico');
  holder.innerHTML = icon(name);
}

function levelLoop() {
  levelRaf = 0;
  const listening = micBtn.dataset.state === 'listening';
  level = Math.max(0, level * 0.9 - 0.004);
  micBtn.style.setProperty('--level', level.toFixed(3));
  const hearing = listening && performance.now() - lastHeard < 1100;
  micBtn.classList.toggle('hearing', hearing);
  if (hearing) {
    const t = performance.now() / 1000;
    bars.forEach((b, i) => {
      const k = [0.45, 0.75, 1, 0.7, 0.4][i];
      const wobble = 0.55 + 0.45 * Math.abs(Math.sin(t * (5.2 + i * 1.7) + i));
      b.style.transform = `scaleY(${(0.22 + Math.min(1, level + 0.25) * k * wobble).toFixed(3)})`;
    });
  }
  if (listening || level > 0.01) levelRaf = requestAnimationFrame(levelLoop);
}
function kickLevel(v) {
  level = Math.max(level, v * (0.78 + Math.random() * 0.22));
  if (!levelRaf) levelRaf = requestAnimationFrame(levelLoop);
}

voice.addEventListener('state', (e) => {
  const { state, message } = e.detail;
  micBtn.dataset.state = state === 'off' ? '' : state;
  const on = state === 'listening' || state === 'starting';
  micBtn.setAttribute('aria-pressed', String(on));
  micBtn.setAttribute('aria-label', on ? 'Stop listening' : 'Start listening');
  setMicIcon(state === 'error' ? 'micOff' : 'mic');
  chat.setListening(on);
  if (state === 'error' && message) toast(message, { tone: 'error', ms: 5200 });
  if (on && !levelRaf) levelRaf = requestAnimationFrame(levelLoop);
  updateCaption();
});
voice.addEventListener('interim', (e) => {
  chat.setInterim(e.detail);
  if (e.detail) {
    lastHeard = performance.now();
    hideHint();
  }
  updateCaption();
  updateSendReady();
});
voice.addEventListener('final', (e) => {
  chat.appendDraft(e.detail.text);
  lastHeard = performance.now();
  updateCaption();
  updateSendReady();
});
voice.addEventListener('level', (e) => {
  if (e.detail >= 1) lastHeard = performance.now();
  kickLevel(e.detail);
});

if (!voiceSupported) {
  micBtn.dataset.state = 'unsupported';
  setMicIcon('micOff');
  micBtn.setAttribute('aria-label', 'Voice input unavailable');
}
micBtn.addEventListener('click', () => {
  if (!voiceSupported) {
    toast('Speech recognition isn’t available here. Tap the text box and use the keyboard’s dictation key instead.', { ms: 5200 });
    if (chat.geo.collapsed) chat.setCollapsed(false);
    setTimeout(() => $('#draft').focus(), 250);
    return;
  }
  hideHint();
  voice.toggle();
});

// ------------------------------------------------------------------ caption + send readiness

function updateCaption() {
  if ($('#talk').classList.contains('live-on')) return; // live mode owns the caption
  const cap = $('#caption');
  const showWhen = chat.geo.collapsed;
  const interim = voice.interim;
  const draft = chat.getDraft().trim();
  let html = '';
  if (draft) {
    const tail = draft.length > 160 ? '…' + draft.slice(-160) : draft;
    html = escapeText(tail);
  }
  if (interim) html += (html ? ' ' : '') + `<em>${escapeText(interim)}</em>`;
  $('#captionText').innerHTML = html;
  cap.classList.toggle('show', !!(showWhen && html));
}
const escapeText = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function hasSomethingToSend() {
  return !!(chat.getDraft().trim() || voice.interim || board.strokesSince(lastSendAt).length);
}
function updateSendReady() {
  const ready = hasSomethingToSend() && !sending;
  $('#btnSend').classList.toggle('ready', ready);
  $('#btnSendInline').classList.toggle('ready', ready);
  $('#btnClearDraft').disabled = !(chat.getDraft() || voice.interim);
}

// ------------------------------------------------------------------ sending

// send() posts the draft; send({text}) posts the given text instead (voice hand-offs) and leaves the draft alone.
async function send(opts = {}) {
  if (sending) {
    if (opts.text) setTimeout(() => send(opts), 400); // a hand-off must not be dropped
    return;
  }
  const own = typeof opts.text === 'string';
  const segments = own ? [] : voice.take();
  const text = own ? opts.text.trim() : chat.getDraft().trim();
  const freshCount = board.strokesSince(lastSendAt).length;
  if (!text && !freshCount && !segments.length) {
    const b = $('#btnSend');
    b.classList.remove('shake');
    void b.offsetWidth;
    b.classList.add('shake');
    hud('Nothing new to send');
    return;
  }
  sending = true;
  $('#btnSend').classList.add('sending');
  updateSendReady();
  const cid = uid('m');
  const clientTs = Date.now();
  let snap;
  try {
    snap = await buildSnapshot({ board, layer, mode: prefs.mode, since: lastSendAt });
  } catch (err) {
    console.error(err);
    toast('Couldn’t capture the board.', { tone: 'error' });
    sending = false;
    $('#btnSend').classList.remove('sending');
    updateSendReady();
    return;
  }
  const timeline = buildTimeline(snap, segments);
  const thumb = await makeThumb(snap.dataUrl);
  chat.add({ cid, role: 'user', text, ts: clientTs, thumb, full: snap.dataUrl, mode: snap.mode,
    width: snap.width, height: snap.height, state: 'sending', local: true });
  if (!own) {
    chat.setDraft('');
    chat.setInterim('');
  }
  lastSendAt = clientTs;
  store.set(sessionKey('lastSendAt'), lastSendAt);
  updateInkChip();
  updateCaption();
  chat.setStatus('sending');
  outbox.set(cid, { text, image: snap.dataUrl, timeline, board_image_mode: snap.mode, cid, client_ts: clientTs,
    width: snap.width, height: snap.height });
  saveOutbox();
  await deliver(cid);
  sending = false;
  const sb = $('#btnSend');
  sb.classList.remove('sending');
  sb.classList.remove('pop-ok');
  void sb.offsetWidth;
  sb.classList.add('pop-ok');
  updateSendReady();
}

async function deliver(cid) {
  const payload = outbox.get(cid);
  if (!payload) return;
  chat.update(cid, { state: 'sending' });
  try {
    const res = await api.post('/api/message', payload, { timeout: 90000 });
    outbox.delete(cid);
    saveOutbox();
    chat.update(cid, { id: res.id, state: 'sent', local: false, image: `/api/inbox/${res.id}/snapshot.png` });
    if (chat.status === 'sending' || chat.status === 'idle') chat.setStatus('sent');
  } catch (err) {
    chat.update(cid, { state: 'failed' });
    chat.setStatus('idle');
    toast(err.status === 401 ? 'The server rejected this link’s key.' : 'Message not delivered — tap Retry in the chat.', { tone: 'error' });
  }
}

$('#btnSend').addEventListener('click', () => send());
chat.addEventListener('send', () => send());
chat.addEventListener('retry', (e) => deliver(e.detail));

// After a reload: show the undelivered messages again and send them (the server skips any it
// already has, so nothing arrives twice).
async function resendOutbox() {
  for (const [cid, p] of [...outbox]) {
    if (!chat.byCid.has(cid)) {
      const thumb = p.image ? await makeThumb(p.image).catch(() => null) : null;
      chat.add({ cid, role: 'user', text: p.text, ts: p.client_ts, thumb, full: p.image, mode: p.board_image_mode,
        width: p.width, height: p.height, state: 'sending', local: true });
    }
    deliver(cid);
  }
}
chat.addEventListener('cleardraft', () => {
  chat.setDraft('');
  voice.discardSegments();
  chat.setInterim('');
  updateCaption();
  updateSendReady();
});
chat.addEventListener('mode', (e) => {
  prefs.mode = e.detail === 'board' ? 'board' : 'view';
  chat.setMode(prefs.mode);
  savePrefs();
});
chat.addEventListener('image', (e) => lightbox(e.detail));
chat.addEventListener('draft', () => {
  if (chat.getDraft()) hideHint();
  updateCaption();
  updateSendReady();
});
function layoutHint() {
  const free = window.innerWidth - chat.dockedWidth;
  document.documentElement.style.setProperty('--chat-inset', `${chat.dockedWidth}px`);
  $('#hint').classList.toggle('stack', free < 640);
}
chat.addEventListener('layout', () => {
  board.rightInset = chat.dockedWidth;
  layoutHint();
  updateCaption();
});
chat.addEventListener('ghost', (e) => hud(e.detail ? 'Pass-through on — draw under the panel' : 'Pass-through off', 'ghost'));

// ------------------------------------------------------------------ settings

const settings = popover($('#settingsPop'), $('#btnSettings'));

// ☰ menu in the Claude panel header: paper style + appearance.
const menu = popover($('#menuPop'), $('#btnMenu'));
function syncMenu() {
  const theme = prefs.theme || 'auto';
  for (const b of document.querySelectorAll('#themeOpts [data-theme-opt]')) {
    const on = b.dataset.themeOpt === theme;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  for (const b of document.querySelectorAll('#paperOpts [data-paper]')) {
    const on = b.dataset.paper === prefs.paper;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}
$('#paperOpts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-paper]');
  if (!b) return;
  prefs.paper = b.dataset.paper;
  savePrefs();
  board.setPaper(prefs.paper);
  syncMenu();
});
$('#themeOpts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-opt]');
  if (!b) return;
  prefs.theme = b.dataset.themeOpt === 'auto' ? null : b.dataset.themeOpt;
  savePrefs();
  applyTheme(initialTheme());
});
$('#optFinger').addEventListener('change', (e) => {
  prefs.fingerDraw = e.target.checked;
  savePrefs();
  board.setFingerDraw(prefs.fingerDraw);
});
$('#optLang').addEventListener('change', (e) => {
  prefs.lang = e.target.value;
  savePrefs();
  voice.setLang(prefs.lang);
});
function setLayerVisible(on) {
  prefs.layer = !!on;
  savePrefs();
  layer.setVisible(prefs.layer);
  $('#optLayer').checked = prefs.layer;
}
// (Showing and hiding Claude's drawings is in Settings; the double-star button opens the menu.)
$('#optLayer').addEventListener('change', (e) => setLayerVisible(e.target.checked));
// Full screen (iPadOS Safari supports the Fullscreen API on elements; iPhone does not).
//
// Why swipes exit: in element full screen, WebKit adds its own one-finger swipe-down
// gesture over the whole page that means "exit full screen" (WKFullScreenWindowControllerIOS:
// a UISwipeGestureRecognizer, direction down, 1 touch, cancelsTouchesInView, plus a pan
// that commits the exit). It runs in UIKit, outside the page, so preventDefault /
// touch-action can't stop it. Two-finger gestures and upward swipes never trigger it.
// So, in full screen:
//   - the chat also scrolls with two fingers (and the board already pans with two);
//   - when a swipe knocks us out (Safari cancels the page's touch first), the next tap
//     anywhere goes straight back into full screen;
//   - the first couple of times, a tip explains the two-finger rule.
{
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement;
  const btn = $('#btnFullscreen');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (req && !standalone) {
    btn.hidden = false;
    let wasOn = false;
    let userExit = false;   // our own button asked to leave
    let lastCancel = -1e9;  // when Safari last cancelled a touch / pen contact in the page
    let restoreTries = 0;   // >0 while "tap anywhere to go back" is armed
    const enter = () => {
      try { return Promise.resolve(req.call(root)).catch(() => {}); } catch { return Promise.resolve(); }
    };
    const onCancel = () => { lastCancel = performance.now(); };
    document.addEventListener('touchcancel', onCancel, { capture: true, passive: true });
    document.addEventListener('pointercancel', onCancel, { capture: true, passive: true });
    const restoreOnTap = (e) => {
      if (!restoreTries || current()) return;
      if (e.target instanceof Element && e.target.closest('#btnFullscreen')) return;
      restoreTries -= 1;
      enter();
    };
    // touchend and click both count as a user gesture; whichever Safari accepts wins.
    document.addEventListener('touchend', restoreOnTap, { capture: true, passive: true });
    document.addEventListener('click', restoreOnTap, true);

    const TIP_KEY = 'canvas.fsTipCount';
    const sync = () => {
      const on = !!current();
      document.documentElement.classList.toggle('is-fs', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
      btn.title = on ? 'Exit full screen' : 'Full screen';
      btn.innerHTML = icon(on ? 'shrink' : 'expand');
      if (on && !wasOn) {
        restoreTries = 0;
        let n = 0;
        try { n = Number(localStorage.getItem(TIP_KEY) || 0); } catch {}
        if (n < 2) {
          try { localStorage.setItem(TIP_KEY, String(n + 1)); } catch {}
          toast('In full screen, scroll the chat and move the board with two fingers. A one-finger swipe down is Safari’s exit gesture.', { ms: 6000 });
        }
      } else if (!on && wasOn) {
        const swiped = !userExit && performance.now() - lastCancel < 2500;
        if (swiped) {
          restoreTries = 3;
          toast('Swiped out of full screen. Tap anywhere to go back. Use two fingers to scroll.', { ms: 5200 });
        }
      }
      userExit = false;
      wasOn = on;
    };
    btn.addEventListener('click', async () => {
      try {
        if (current()) {
          userExit = true;
          await exit.call(document);
        } else {
          await req.call(root);
        }
      } catch {
        userExit = false;
        toast('Full screen isn’t available here. Use Share → Add to Home Screen instead.');
      }
    });
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
  }

  // While in full screen, scroll the chat from JS so it works with one OR two fingers
  // (two-finger scrolling is the safe way, see above). touch-action:none is set on it
  // under html.is-fs in app.css.
  const manualScroll = (el) => {
    if (!el) return;
    let active = false, lastY = 0, lastT = 0, vel = 0, raf = 0, count = 0;
    const inFs = () => !!current();
    const avgY = (ts) => {
      let s = 0;
      for (const t of ts) s += t.clientY;
      return s / ts.length;
    };
    const rebase = (e) => {
      lastY = avgY(e.targetTouches);
      lastT = performance.now();
      count = e.targetTouches.length;
    };
    el.addEventListener('touchstart', (e) => {
      if (!inFs()) return;
      cancelAnimationFrame(raf);
      if (!active) vel = 0;
      active = true;
      rebase(e);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!active || !e.targetTouches.length) return;
      e.preventDefault();
      if (e.targetTouches.length !== count) {
        rebase(e);
        return;
      }
      const y = avgY(e.targetTouches);
      const t = performance.now();
      const dy = lastY - y;
      el.scrollTop += dy;
      vel = 0.8 * vel + 0.2 * (dy / Math.max(1, t - lastT)) * 16;
      lastY = y;
      lastT = t;
    }, { passive: false });
    const end = (e) => {
      if (!active) return;
      if (e.targetTouches && e.targetTouches.length) {
        rebase(e); // one finger lifted, the other keeps scrolling
        return;
      }
      active = false;
      const step = () => {
        if (Math.abs(vel) < 0.25) return;
        const before = el.scrollTop;
        el.scrollTop += vel;
        if (el.scrollTop === before) return; // hit an edge
        vel *= 0.95;
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', end, { passive: true });
  };
  document.querySelectorAll('[data-scroll]').forEach(manualScroll);
}
$('#btnFit').addEventListener('click', () => {
  settings.close();
  board.fitContent(layer.bounds());
});
$('#btnZoom').addEventListener('click', () => {
  if (Math.abs(board.cam.z - 1) < 0.01) board.fitContent(layer.bounds());
  else board.resetZoom();
});
$('#btnClearClaude').addEventListener('click', async () => {
  settings.close();
  if (!layer.count) return hud('No drawings from Claude');
  const ok = await confirmSheet({ title: 'Clear Claude’s drawings?', message: 'Removes everything Claude has drawn on the board.', confirm: 'Clear', destructive: true });
  if (!ok) return;
  layer.clear();
  try { await api.post('/api/draw/clear', {}); } catch { toast('Couldn’t reach the server.', { tone: 'error' }); }
});
$('#btnClearBoard').addEventListener('click', async () => {
  settings.close();
  if (!board.strokes.length) return hud('The board is already empty');
  const ok = await confirmSheet({ title: 'Clear the board?', message: 'All of your ink will be removed. You can undo this.', confirm: 'Clear Board', destructive: true });
  if (!ok) return;
  board.clearBoard();
  toast('Board cleared.', { action: 'Undo', onAction: () => board.undo() });
});

// ------------------------------------------------------------------ keyboard

window.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    send();
    return;
  }
  if (typing) return;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') {
    e.preventDefault();
    if (e.shiftKey) board.redo(); else board.undo();
    return;
  }
  if (mod && k === 'y') {
    e.preventDefault();
    board.redo();
    return;
  }
  if (mod || e.altKey) return;
  const tools = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', v: 'lasso' };
  if (tools[k]) return setTool(tools[k]);
  if (k === 'm') return micBtn.click();
  if (k === '0') return board.resetZoom();
  if (k === 'f') return board.fitContent(layer.bounds());
  if (k === '[' || k === ']') {
    const fam = board.widthFamily;
    board.setWidth(board.widthIdx[fam] + (k === ']' ? 1 : -1));
    return;
  }
  if (/^[1-8]$/.test(k)) return board.setColor(COLORS[+k - 1].key);
  if (k === 'backspace' || k === 'delete') return board.deleteSelection();
  if (k === 'escape') return board.clearSelection();
});

// ------------------------------------------------------------------ iOS / viewport hardening

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) {
    e.preventDefault();
    return;
  }
  const t = e.target;
  if (!(t instanceof Element) || !t.closest('[data-scroll], textarea, input[type="range"], .settings-pop, .md pre, .md .math-block, .md table')) {
    e.preventDefault();
  }
}, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

// The drawing toolbar is centred, but never over the mic and send buttons at the bottom left:
// on a narrow screen (an iPad upright) it moves right, or up above them if there's no room beside.
function placeToolbar() {
  const root = document.documentElement.style;
  const tb = $('#toolbar'), talk = $('#talk');
  const vw = window.innerWidth;
  let shift = 0, lift = 0;
  if (tb && talk && vw > 560) { // phones: the toolbar sits at the right edge instead (app.css)
    const w = tb.offsetWidth;
    const clear = talk.getBoundingClientRect().right + 12;
    const centred = (vw - w) / 2;
    if (centred < clear) {
      if (clear + w <= vw - 14) shift = clear - centred;
      else lift = talk.offsetHeight + 10;
    }
  }
  root.setProperty('--tb-shift', `${Math.round(shift)}px`);
  root.setProperty('--tb-lift', `${Math.round(lift)}px`);
}
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => placeToolbar());
  ro.observe($('#toolbar'));
  ro.observe($('#talk'));
}

let resizeTimer = 0;
function onResize() {
  document.documentElement.classList.add('resizing');
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => document.documentElement.classList.remove('resizing'), 260);
  board.resize();
  chat.onViewportChange();
  placeToolbar();
  requestAnimationFrame(moveToolIndicator);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 120));

if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', `${kb > 60 ? Math.round(kb) : 0}px`);
  };
  vv.addEventListener('resize', onVV);
  vv.addEventListener('scroll', onVV);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    ink.flush();
    saveCam.flush();
  }
});
window.addEventListener('pagehide', () => ink.flush());

// ------------------------------------------------------------------ server sync

function deriveLastSend(conversation) {
  let ts = 0;
  for (const m of conversation || []) if (m.role === 'user') ts = Math.max(ts, m.client_ts || m.ts || 0);
  return ts;
}

// The chat's latest page, Claude's layer and the status (ink comes separately, as changes).
const CHAT_PAGE = 80;
chat.addEventListener('loadEarlier', async (e) => {
  try {
    const res = await api.get(`/api/conversation?before=${encodeURIComponent(e.detail.before)}&limit=60`);
    chat.prependOlder(res.conversation || [], !!res.more);
  } catch {
    chat.earlierFailed();
  }
});
async function resync() {
  const session = SESSION;
  const st = await api.get(`/api/state?conv=${CHAT_PAGE}&strokes=0`);
  // another board was opened while this was on its way: it isn't this board's state
  if (session !== SESSION) throw Object.assign(new Error('another board is open now'), { stale: true });
  applyState(st);
  return st;
}
function applyState(st) {
  chat.setConversation(st.conversation || [], { more: !!st.conversation_more });
  layer.setAll(st.claude_layer || []);
  chat.setStatus(st.status || 'idle');
  if (!outbox.size) {
    // the page only has the latest chat entries: never move "last sent" backwards
    lastSendAt = Math.max(deriveLastSend(st.conversation), store.get(sessionKey('lastSendAt'), 0) || 0);
    store.set(sessionKey('lastSendAt'), lastSendAt);
  }
  updateInkChip();
  updateSendReady();
}

events.addEventListener('state', (e) => {
  chat.setConnection(e.detail);
  const labels = { open: 'Connected to your Claude Code session', connecting: 'Connecting…', reconnecting: 'Reconnecting…' };
  $('#connInfo').textContent = labels[e.detail] || 'Offline';
  $('#connDot').dataset.state = e.detail === 'open' ? 'ok' : 'wait';
});
// ------------------------------------------------------------------ live conversation (voice talker)

// Board view for the talker's "LOOK": a JPEG of what you see, at most 1024 px wide.
async function boardForTalker() {
  const snap = await buildSnapshot({ board, layer, mode: 'view', since: lastSendAt });
  const img = new Image();
  img.src = snap.dataUrl;
  await img.decode();
  const scale = Math.min(1, 1024 / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

// Live voice runs its own recogniser (live.js); the dictation mic above is stopped first.
const live = new Live({
  voiceSupported,
  snapshot: boardForTalker,
  viewRect: () => board.viewRect(),
  // changes whenever the ink, the Claude drawings or the view change
  boardRev: () => {
    const last = board.strokes[board.strokes.length - 1];
    const c = board.cam;
    return `${board.strokes.length}:${last ? last.id : ''}:${Math.round(c.x)}:${Math.round(c.y)}:${c.z.toFixed(3)}:${layer.records ? layer.records.size : ''}`;
  },
  sendToMain: (task, heard) => send({ text: `🎙 ${task}${heard ? `\n\n(heard: “${heard}”)` : ''}` }),
  toast,
});
live.setVoiceName(prefs.voiceName);

// ☰ menu › Voice: the device's English voices, most natural first. Tap = choose + hear it.
function renderVoices() {
  const box = $('#voiceOpts');
  const list = rankVoices().slice(0, 12);
  box.textContent = '';
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'voice-empty';
    p.textContent = 'Voices are still loading. Open the menu again in a moment.';
    box.append(p);
    return;
  }
  const current = list.some((v) => v.name === prefs.voiceName) ? prefs.voiceName : list[0].name;
  for (const v of list) {
    const b = document.createElement('button');
    b.dataset.voice = v.name;
    b.setAttribute('role', 'radio');
    const on = v.name === current;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    const label = document.createElement('span');
    label.textContent = v.label;
    const tag = document.createElement('small');
    tag.textContent = [v.quality, v.region].filter(Boolean).join(' · ');
    b.append(label, tag);
    box.append(b);
  }
}
$('#btnMenu').addEventListener('click', renderVoices);
window.speechSynthesis?.addEventListener?.('voiceschanged', renderVoices);
$('#voiceOpts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-voice]');
  if (!b) return;
  prefs.voiceName = b.dataset.voice;
  savePrefs();
  live.preview(prefs.voiceName);
  renderVoices();
});

// ---- updates: a code change on the PC reaches this page by itself.
// Each poll reports the server's build. When it differs from the build this page loaded (the
// ?v= on its own script URL), the page reloads the moment you're idle: not drawing, moving a
// card, typing, talking (Live), sending, or looking at something full screen; at once if the
// app is in the background. It carries over what a reload would lose (undo / redo history,
// the draft, the camera), so it feels like nothing happened but "Canvas updated". If a reload
// somehow still runs old code, it doesn't loop: it offers a Reload button instead.
// (The iPad app's own native code is the one part that needs an install: see appVersion below.)
const PAGE_BUILD = new URL(import.meta.url).searchParams.get('v');
const CARRY = 'canvas.carry';
let updateTo = null;
let lastInput = Date.now();
for (const t of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input']) {
  window.addEventListener(t, () => { lastInput = Date.now(); }, { capture: true, passive: true });
}
function idleEnoughToUpdate() {
  const typing = document.activeElement && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName);
  const quiet = Date.now() - lastInput;
  return quiet > 4000 && !(typing && quiet < 30000) && !board.busy && !cards.drag && !live.on && !voice.on
    && !sending && !viewer.isOpen && !viewer.busy && !document.querySelector('.modal:not([hidden])');
}
events.addEventListener('build', (e) => {
  if (!PAGE_BUILD || !e.detail || e.detail === PAGE_BUILD || updateTo) return;
  if (sessionStorage.getItem('canvas.updatedTo') === e.detail) { // reloaded for it already: no loop
    updateTo = e.detail;
    toast('Canvas was updated.', { action: 'Reload', onAction: () => location.reload(), ms: 24 * 3600 * 1000 });
    return;
  }
  updateTo = e.detail;
  updateWhenIdle();
});
let updateWaitSince = 0, updateNoticeShown = false;
function updateWhenIdle() {
  if (document.hidden || idleEnoughToUpdate()) return applyUpdate();
  // voice keeps the page from reloading under you: after a while, say an update is waiting
  if (!updateWaitSince) updateWaitSince = Date.now();
  if (!updateNoticeShown && Date.now() - updateWaitSince > 20000 && (live.on || voice.on)) {
    updateNoticeShown = true;
    toast('A canvas update is ready (it waits while voice is on).', { action: 'Reload', onAction: () => applyUpdate(), ms: 24 * 3600 * 1000 });
  }
  setTimeout(updateWhenIdle, 1500);
}
async function applyUpdate() {
  try {
    sessionStorage.setItem('canvas.updatedTo', updateTo);
    sessionStorage.setItem(CARRY, JSON.stringify({
      session: SESSION, at: Date.now(), history: board.exportHistory(), draft: chat.getDraft(),
    }));
  } catch { /* too big to carry: the update still happens */ }
  saveCam.flush();
  ink.saveCopy(true);
  await Promise.race([ink.flush(), new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
  location.reload();
}
// after an automatic update: put back what the reload would have lost
function restoreCarried() {
  let c = null;
  try { c = JSON.parse(sessionStorage.getItem(CARRY) || 'null'); sessionStorage.removeItem(CARRY); } catch { /* none */ }
  if (!c || c.session !== SESSION || Date.now() - (c.at || 0) > 120000) return;
  board.importHistory(c.history);
  if (c.draft && !chat.getDraft()) chat.setDraft(c.draft);
  hud('Canvas updated');
}

// The iPad app's own code (not this page) changes only with an install from SideStore: when
// the PC has a newer build than the one running, say so once per version.
events.addEventListener('app', (e) => {
  const latest = e.detail && e.detail.version;
  const mine = window.__canvasNative && window.__canvasNative.version;
  if (!latest || !mine || !newerVersion(latest, mine) || store.get('appNoticeFor', '') === latest) return;
  store.set('appNoticeFor', latest);
  toast(`Canvas ${latest} is ready: update the app in SideStore.`, { ms: 9000 });
});
function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// ---- sessions: one board + chat per Claude session (on this PC, another machine, or in the cloud).
// Boards are switched and made in the menu (below: "home"); the panel title just names this one.
// A Claude session attaches with canvas_agent.py; the instructions it needs are served at /agent.
// "New reply" compares each session's last reply with when you last saw it.
let sessionList = [];
const seen = store.get('sessionSeen', {});
function markSeen(id, ts) {
  seen[id] = Math.max(seen[id] || 0, ts || Date.now());
  store.set('sessionSeen', seen);
}
markSeen(SESSION, Date.now());
const connectLink = (id) => `${location.origin}/agent?k=${encodeURIComponent(KEY)}&s=${encodeURIComponent(id)}`;
const connectText = (id) => `Connect to my canvas as session "${id}". Follow the instructions at ${connectLink(id)}`;

function updateSessionTitle() {
  const cur = sessionList.find((x) => x.id === SESSION);
  $('#sessionName').textContent = cur ? cur.title : SESSION;
}

function onSessions(list) {
  if (!Array.isArray(list)) return;
  let changed = false;
  const firstRun = !Object.keys(seen).length; // a fresh install: every board is "new", say nothing
  for (const s of list) {
    if (seen[s.id] === undefined) {
      seen[s.id] = s.last_reply || 0; // existing = read
      changed = true;
      // a Claude session just ran /canvas:connect: offer its board (one tap; no switching under you)
      if (!firstRun && s.id !== SESSION && s.agent && Date.now() - (s.created || 0) < 10 * 60 * 1000) {
        toast(`New board “${s.title || s.id}” from Claude.`, { action: 'Open', onAction: () => openBoard(s.id), ms: 15000 });
      }
    }
  }
  if (changed) store.set('sessionSeen', seen);
  sessionList = list;
  updateSessionTitle();
}
events.addEventListener('sessions', (e) => onSessions(e.detail));
api.get('/api/sessions').then((r) => onSessions(r && r.sessions)).catch(() => {});

// How to attach a Claude session to a board: the text to paste into Claude Code, copied.
async function copyConnect(id) {
  try {
    await navigator.clipboard.writeText(connectText(id));
    toast('Copied. Paste it into any Claude Code session to attach it to this board.');
  } catch {
    toast(`Couldn’t copy. In Claude Code, run /canvas:connect ${id}`, { ms: 8000 });
  }
}

// Another board, in place: no reload, so nothing goes blank. The toolbar and chat stay; the
// board fades out, what was drawn on it is sent (or kept on this device for it), and the new
// board fades in from this device's copy and the server.
let opening = null;
async function openBoard(id) {
  if (!id || id === SESSION || opening) return;
  opening = id;
  const el = $('#board');
  const t0 = performance.now();
  try {
    if (viewer.isOpen) viewer.close();
    el.classList.remove('board-in');
    el.classList.add('board-out');
    const faded = new Promise((r) => setTimeout(r, 170));
    saveCam.flush(); // this board's view, under this board
    await ink.switchTo(id);
    setSession(id);
    events.reset();
    const stateP = api.get(`/api/state?conv=${CHAT_PAGE}&strokes=0`);
    stateP.catch(() => {});
    // this board's own things on this device
    outbox.clear();
    for (const [k, v] of Object.entries(store.get(sessionKey('outbox'), {}) || {})) outbox.set(k, v);
    lastSendAt = store.get(sessionKey('lastSendAt'), 0) || 0;
    markSeen(id, Date.now());
    updateSessionTitle();
    await faded;
    // behind the fade: the new board's view, ink and drawings (the chat swaps when its
    // messages are here, so it never shows empty in between)
    board.load([]);
    layer.setAll([]);
    const cam = store.get(sessionKey('cam'), null);
    if (cam && Number.isFinite(cam.x) && Number.isFinite(cam.z)) board.setCamera(cam.x, cam.y, cam.z);
    else board.setCamera(0, 0, 1);
    const inkReady = ink.start();
    let st = null;
    const stateReady = stateP.then((s) => {
      if (SESSION !== id) return;
      st = s;
      chat.reset();
      applyState(s);
    }).catch(() => { if (SESSION === id) chat.reset(); });
    await Promise.race([Promise.all([inkReady, stateReady]), new Promise((r) => setTimeout(r, 1200))]);
    if (SESSION !== id) return;
    el.classList.remove('board-out');
    el.classList.add('board-in');
    setTimeout(() => el.classList.remove('board-in'), 420);
    const shown = performance.now();
    await stateReady;
    if (SESSION !== id) return;
    if (st) events.resume(st.events);
    else {
      toast('Can’t reach the Canvas server — retrying…', { tone: 'error' });
      setTimeout(() => resync().then((s) => { events.resume(s.events); events.kick(); }).catch(() => {}), 3000);
    }
    events.connect();
    resendOutbox();
    if (!board.strokes.length && !layer.count && !((st && st.conversation) || []).length) showHint();
    else hideHint();
    if (live.on) api.post('/api/talk', { kind: 'warmup' }, { timeout: 15000 }).catch(() => {});
    api.post('/api/clientlog', { kind: 'boardswitch', ua: navigator.userAgent,
      msg: `to ${id} · shown ${Math.round(shown - t0)} ms · state ${st ? 'ok' : 'failed'} · ink ${board.strokes.length} strokes · ${Math.round(performance.now() - t0)} ms` }).catch(() => {});
  } catch (err) {
    console.warn('switching boards failed', err);
    switchSession(id); // the old way still works: a reload
  } finally {
    opening = null;
  }
}

// ---- the menu ("home"): your boards, what's connected, and Continue. It opens when the app
// starts (once per launch: sessionStorage survives a reload, not a relaunch) and from the
// double-star button in the toolbar. Tapping a board opens it in place, behind the fade.
const home = $('#home');
const homeInfo = { plugin: '', rtt: null };
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
function renderHomeStatus() {
  const conn = $('#conn');
  const ok = conn.dataset.state === 'ok';
  $('#homePcDot').dataset.state = ok ? 'ok' : 'wait';
  $('#homePc').textContent = ok ? 'Connected' : (conn.title || 'Connecting…');
  $('#homePcSub').textContent = ok && homeInfo.rtt != null ? `${Math.max(1, Math.round(homeInfo.rtt))} ms away` : '';
  $('#homeVoice').textContent = prefs.voiceName || 'System voice';
  $('#homeVoiceSub').textContent = live.on ? 'hands-free on' : 'hands-free off';
  const appVersion = (navigator.userAgent.match(/CanvasApp\/([\d.]+)/) || [])[1];
  $('#homeVersion').textContent = appVersion ? `app ${appVersion}` : 'web page';
  $('#homeVersionSub').textContent = homeInfo.plugin ? `plugin ${homeInfo.plugin}` : '';
}
function renderHome() {
  if (home.hidden) return;
  // the board you're on first, then boards with Claude attached, then the rest; newest first
  const rank = (x) => (x.id === SESSION ? 0 : x.agent ? 1 : 2);
  const list = [...sessionList].sort((a, b) => rank(a) - rank(b) || (b.last_activity || 0) - (a.last_activity || 0));
  $('#homeCount').textContent = list.length ? String(list.length) : '';
  const box = $('#homeList');
  box.textContent = '';
  for (const s of list) {
    const row = document.createElement('button');
    row.className = 'home-row' + (s.id === SESSION ? ' on' : '');
    row.dataset.board = s.id;
    const dot = document.createElement('span');
    dot.className = 'dot' + (s.agent ? ' attached' : ''); // green: a Claude session is attached
    const text = document.createElement('span');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = s.title || s.id;
    if (s.id !== SESSION && (s.last_reply || 0) > (seen[s.id] || 0)) {
      const n = document.createElement('span');
      n.className = 'newreply';
      n.textContent = 'New reply';
      t.append(n);
    }
    const sub = document.createElement('span');
    sub.className = 's';
    const replied = ago(s.last_reply);
    sub.textContent = s.agent ? (replied ? `Last reply ${replied}` : 'Claude attached')
      : ['No Claude attached', ago(s.last_activity)].filter(Boolean).join(' · ');
    text.append(t, sub);
    const end = document.createElement('span');
    end.className = s.id === SESSION ? 'open' : 'chev';
    end.textContent = s.id === SESSION ? 'Open →' : '›';
    row.append(dot, text, end);
    box.append(row);
  }
  // Continue: back to the board you were on, only while it's online (a Claude session attached);
  // otherwise there's nothing to continue, so no button: pick a board from the list
  const cur = sessionList.find((x) => x.id === SESSION);
  $('#homeContinue').hidden = !(cur && cur.agent);
  $('#homeCurrent').textContent = cur ? cur.title : SESSION;
  renderHomeStatus();
}
function openHome() {
  if (home.classList.contains('shown')) return;
  home.hidden = false;
  renderHome();
  requestAnimationFrame(() => requestAnimationFrame(() => home.classList.add('shown')));
  const t0 = performance.now();
  api.get('/api/ping').then((r) => {
    homeInfo.rtt = performance.now() - t0;
    if (r && r.plugin) homeInfo.plugin = String(r.plugin);
    if (!home.hidden) renderHomeStatus();
  }).catch(() => {});
}
function closeHome() {
  if (home.hidden) return;
  home.classList.remove('shown');
  $('#homeNewForm').hidden = true;
  $('#homeNew').hidden = false;
  setTimeout(() => { if (!home.classList.contains('shown')) home.hidden = true; }, 320);
}
$('#btnLayer').addEventListener('click', openHome);
$('#homeContinue').addEventListener('click', closeHome);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !home.hidden) closeHome(); });
$('#homeList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-board]');
  if (!row) return;
  const id = row.dataset.board;
  closeHome();
  if (id !== SESSION) openBoard(id);
});
$('#homeNew').addEventListener('click', () => {
  $('#homeNew').hidden = true;
  $('#homeNewForm').hidden = false;
  $('#homeNewName').focus();
});
$('#homeNewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#homeNewName');
  const title = input.value.trim();
  if (!title) return;
  try {
    const s = await api.post('/api/sessions', { title });
    input.value = '';
    sessionList = [...sessionList.filter((x) => x.id !== s.id), s];
    markSeen(s.id, Date.now());
    closeHome();
    await openBoard(s.id);
    // no Claude on it yet: how to attach one
    toast(`Board “${s.title || s.id}” is ready. To attach Claude, run /canvas:connect ${s.id} in Claude Code.`,
      { action: 'Copy', onAction: () => copyConnect(s.id), ms: 15000 });
  } catch (err) {
    toast(`Couldn’t create the board: ${err.message}`, { tone: 'error' });
  }
});
events.addEventListener('sessions', () => renderHome());
events.addEventListener('state', () => { if (!home.hidden) renderHomeStatus(); });

// ---- inside the iPad app (canvas/ios). It injects window.__canvasNative and runs speech on
// Apple's native engines (every installed voice, including Premium ones Safari hides).
const native = window.__canvasNative || null;
if (native) {
  $('#btnFullscreen').hidden = true;
  $('#menuApp').hidden = false;
  $('#btnServerLink').hidden = false;
  $('#btnServerLink').addEventListener('click', () => native.post('settings'));
  $('#btnReload').hidden = false; // also in the app's menu bar: Canvas › Reload (⌘R)
  $('#btnReload').addEventListener('click', () => location.reload());
  $('#voiceHint').textContent = 'Tap a voice to hear it. Every voice you download (Settings › Accessibility › Read & Speak › Voices) shows up here.';
  // Apple Pencil Pro squeeze: voice mode on / off
  window.addEventListener('canvas:pencil-squeeze', () => {
    if (live.on) {
      live.stop();
    } else {
      hideHint();
      if (voice.on) voice.stop();
      chat.setInterim('');
      live.start(prefs.lang);
    }
  });
  // Pencil double-tap: eraser and back
  let beforeEraser = prefs.tool && prefs.tool !== 'eraser' ? prefs.tool : 'pen';
  window.addEventListener('canvas:pencil-tap', () => {
    if (board.tool === 'eraser') {
      setTool(beforeEraser);
    } else {
      beforeEraser = board.tool;
      setTool('eraser');
    }
  });
} else if (navigator.maxTouchPoints > 1 && /iPad|iPhone|Macintosh/.test(navigator.userAgent)) {
  // Safari on the iPad: hand this canvas (with its key) to the app
  $('#menuApp').hidden = false;
  $('#btnOpenApp').hidden = false;
  $('#btnOpenApp').addEventListener('click', () => {
    const link = `${location.origin}/?k=${encodeURIComponent(KEY)}`;
    location.href = `canvasapp://open?url=${encodeURIComponent(link)}`;
  });
}

const liveBtn = $('#btnLive');
const LIVE_LABEL = {
  off: 'Live', listening: 'Listening', hearing: 'Hearing you', thinking: 'Thinking',
  looking: 'Looking at the board', speaking: 'Speaking',
};
const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
live.addEventListener('state', (e) => {
  const { state, caption, working } = e.detail;
  liveBtn.dataset.state = state;
  liveBtn.classList.toggle('on', state !== 'off');
  liveBtn.classList.toggle('working', !!working);
  liveBtn.setAttribute('aria-pressed', String(state !== 'off'));
  $('#liveState').textContent = LIVE_LABEL[state] || 'Live';
  let sub = caption || '';
  if (!sub && working) sub = `Main agent working · ${fmtSecs(working.secs)}`;
  $('#talk').classList.toggle('live-on', state !== 'off');
  // captions go in the bubble above the controls
  const cap = $('#caption');
  if (state === 'off') {
    cap.classList.remove('show', 'live-cap');
    updateCaption();
    return;
  }
  cap.classList.add('live-cap');
  $('#captionText').textContent = sub.length > 220 ? '…' + sub.slice(-220) : sub;
  cap.classList.toggle('show', !!sub);
});
liveBtn.addEventListener('click', (e) => {
  if (e.target.closest('#liveStop')) {
    live.stop();
    return;
  }
  if (!live.on) {
    hideHint();
    if (voice.on) voice.stop();
    chat.setInterim('');
    live.start(prefs.lang);
  } else {
    live.tap();
  }
});

// 'hello' = the server couldn't replay what we missed (it restarted, or we slept through more
// than it keeps): reload the conversation and the layer from its state.
events.addEventListener('hello', () => {
  resync().catch(() => {});
  ink.catchUp(); // just the ink changes we missed (or the whole board if too many)
});
events.addEventListener('message', (e) => {
  const m = e.detail;
  if (!m) return;
  chat.add(m, { animate: true });
  if (m.client_ts) {
    lastSendAt = Math.max(lastSendAt, m.client_ts);
    updateInkChip();
  }
});
events.addEventListener('reply', (e) => {
  if (!e.detail) return;
  chat.add(e.detail, { animate: true });
  markSeen(SESSION, e.detail.ts);
  // a main-agent reply while live: the talker says the gist out loud
  if (live.on && e.detail.source !== 'talker') live.onMainReply(e.detail.text);
});
events.addEventListener('talk', (e) => live.onTalkEvent(e.detail));
events.addEventListener('progress', (e) => { if (e.detail) chat.add(e.detail, { animate: true }); });
events.addEventListener('status', (e) => chat.setStatus(e.detail || 'idle'));
events.addEventListener('draw', (e) => {
  const item = e.detail;
  const rec = layer.upsert(item, { animate: true });
  if (!rec) return;
  if (!layer.visible) {
    toast('Claude drew something.', { action: 'Show', onAction: () => setLayerVisible(true) });
    return;
  }
  const r = layer.rectOf(rec);
  if (!rectsIntersect(r, board.viewRect())) {
    const what = item.label ? `Claude drew “${item.label}”.` : 'Claude drew something.';
    toast(what, {
      action: 'Show',
      onAction: () => {
        board.animateTo(board.cameraForRect(r, 120, board.cam.z));
        setTimeout(() => layer.flash(item.id), 360);
      },
    });
  }
});
events.addEventListener('draw_remove', (e) => e.detail && layer.remove(e.detail.id));
// a live card's new data (charts growing, an agent's page updating): straight into its page
events.addEventListener('card_data', (e) => {
  const rec = e.detail && layer.byPage(e.detail.page);
  if (rec) rec.live.data(e.detail);
  if (e.detail && stagePage && stagePage.page === e.detail.page) stagePage.link.data(e.detail);
});
events.addEventListener('page_reload', (e) => {
  const rec = e.detail && layer.byPage(e.detail.page);
  if (rec) rec.live.reload();
  if (e.detail && stagePage && stagePage.page === e.detail.page) stagePage.link.reload(stagePage.src);
});
// a card was moved or resized (here or on another device): just reposition it
events.addEventListener('draw_move', (e) => {
  const g = e.detail;
  if (!g || (cards.drag && cards.drag.id === g.id)) return; // you're holding it right now
  layer.place(g.id, g);
});
events.addEventListener('draw_clear', () => layer.clear());
events.addEventListener('ink', (e) => ink.onEvent(e.detail));

// ------------------------------------------------------------------ boot

function restorePrefs() {
  board.color = { pen: 'ink', hl: 'yellow', ...prefs.color };
  board.widthIdx = { pen: 1, hl: 1, eraser: 1, ...prefs.width };
  board.setTool(prefs.tool || 'pen');
  board.setFingerDraw(prefs.fingerDraw);
  board.setPaper(prefs.paper);
  syncMenu();
  $('#optFinger').checked = !!prefs.fingerDraw;
  $('#optLang').value = prefs.lang;
  chat.setMode(prefs.mode);
  setLayerVisible(prefs.layer !== false);
  const cam = store.get(sessionKey('cam'), null);
  if (cam && Number.isFinite(cam.x) && Number.isFinite(cam.z)) board.setCamera(cam.x, cam.y, cam.z, { silent: true });
  zoomPct = Math.round(board.cam.z * 100);
  $('#zoomLabel').textContent = `${zoomPct}%`;
}

// One line per page load in data/client.log: where the start-up time went, measured on the
// device itself (ms since the page started loading).
function reportBoot(t) {
  try {
    const ms = (x) => (Number.isFinite(x) ? Math.round(x) : '-');
    const nav = performance.getEntriesByType('navigation')[0];
    const files = performance.getEntriesByType('resource').filter((r) => /\.(js|css)(\?|$)/.test(r.name));
    const sized = files.some((r) => typeof r.transferSize === 'number');
    const cached = sized ? files.filter((r) => r.transferSize === 0).length : '?';
    const slow = files.slice().sort((a, b) => b.duration - a.duration)[0];
    const msg = `board ${SESSION} · page ${ms(nav && nav.responseEnd)} · code ${ms(T_CODE)}` +
      ` (${files.length} files, ${cached} cached${slow ? `, slowest ${slow.name.split('?')[0].split('/').pop()} ${ms(slow.duration)}` : ''})` +
      ` · ui ${ms(t.ui)} · state ${ms(t.state)} · storage ${cacheStats.result || '-'} ${cacheStats.ms}` +
      ` · ink ${ms(t.ink)} · ready ${ms(t.ready)}`;
    api.post('/api/clientlog', { kind: 'boottime', msg, ua: navigator.userAgent }).catch(() => {});
  } catch { /* best effort */ }
}

async function boot() {
  const t = {};
  applyTheme(initialTheme());
  restorePrefs();
  refreshToolbar();
  board.rightInset = chat.dockedWidth;
  layoutHint();
  if (!KEY) {
    $('#lockedMsg').textContent = 'Open the link that includes ?k=<key> (printed by server.py).';
    $('#locked').hidden = false;
  }
  // Show the canvas right away: the ink, chat and drawings fill in as they arrive. (A timer
  // backs up the frames, which don't run while the page is hidden.)
  const showUi = () => {
    if (t.ui) return;
    t.ui = performance.now();
    app.classList.remove('booting');
    moveToolIndicator();
    if (window.__canvasBooted) window.__canvasBooted();
  };
  requestAnimationFrame(() => requestAnimationFrame(showUi));
  setTimeout(showUi, 400);
  // the menu comes first when the app starts (not on a reload: sessionStorage outlives that)
  if (KEY) {
    let first = true;
    try {
      first = !sessionStorage.getItem('homeShown');
      sessionStorage.setItem('homeShown', '1');
    } catch { /* no storage: show it */ }
    if (first) openHome();
  }
  const inkReady = ink.start(); // the board at once from this device's copy, if it has one
  inkReady.then(() => { t.ink = performance.now(); });
  try {
    const st = await resync();
    t.state = performance.now();
    events.resume(st.events); // live updates pick up exactly where this snapshot ends
    await sendLegacyBackup();
    await inkReady;    // the board, then anything drawn here that never reached the server
    restoreCarried();  // after an automatic update: undo history and the draft, as they were
    resendOutbox();    // and any message that never reached it
    if (!board.strokes.length && !layer.count && !(st.conversation || []).length) showHint();
  } catch (err) {
    if (err.stale) {
      // another board was opened while this one was loading: openBoard took over
    } else if (err.status === 404 && SESSION !== 'main') {
      switchSession('main'); // that session no longer exists
      return;
    }
    if (err.status === 401) {
      $('#lockedMsg').textContent = 'This link’s key was rejected. Open the URL printed by server.py.';
      $('#locked').hidden = false;
    } else {
      toast('Can’t reach the Canvas server — retrying…', { tone: 'error' });
      inkReady.then(() => ink.showUnsent()); // this device's copy, or at least what was drawn here
      setTimeout(() => resync().catch(() => {}), 3000);
    }
  }
  events.connect();
  t.ready = performance.now();
  reportBoot(t);
}

if (window.__canvas) Object.assign(window.__canvas, { resync, events, chat }); // tests (?debug)
boot();
