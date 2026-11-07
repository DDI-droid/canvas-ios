// Canvas — app wiring: board + Claude layer + chat overlay + voice + server sync.
import { Board } from './board.js';
import { ClaudeLayer } from './claude-layer.js';
import { ChatPanel } from './chat.js';
import { Voice, voiceSupported } from './voice.js';
import { Live, rankVoices } from './live.js';
import { buildSnapshot, buildTimeline, makeThumb } from './snapshot.js';
import { api, EventStream, KEY } from './api.js';
import { COLORS, inkColor } from './palette.js';
import { hydrateIcons, icon } from './icons.js';
import { confirmSheet, hud, lightbox, popover, toast } from './ui.js';
import { $, $$, clamp, debounce, rectsIntersect, store, uid } from './util.js';

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
const chat = new ChatPanel();
const voice = new Voice(prefs.lang);
const events = new EventStream('/api/events');

let lastSendAt = store.get('lastSendAt', 0);
let sending = false;
const outbox = new Map();

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

const saveCam = debounce(() => store.set('cam', board.cam), 400);
board.addEventListener('tool', refreshToolbar);
board.addEventListener('history', refreshToolbar);
board.addEventListener('hud', (e) => hud(e.detail.text, e.detail.icon));
board.addEventListener('view', (e) => {
  layer.sync(e.detail);
  hideItemMenu();
});
board.addEventListener('camera', (e) => {
  $('#zoomLabel').textContent = `${Math.round(e.detail.z * 100)}%`;
  saveCam();
});
board.addEventListener('change', (e) => {
  if (e.detail.local) {
    scheduleSave();
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
board.onLongPress = ({ x, y, wx, wy }) => {
  const id = layer.hitTest(wx, wy, 8 / board.cam.z);
  if (!id) return false;
  showItemMenu(id, x, y);
  return true;
};

function updateInkChip() {
  chat.setNewInk(board.strokesSince(lastSendAt).length);
}

// ------------------------------------------------------------------ Claude-layer item menu

let menuItem = null;
function showItemMenu(id, x, y) {
  const m = $('#itemMenu');
  menuItem = id;
  layer.flash(id);
  m.hidden = false;
  const w = m.offsetWidth || 200, h = m.offsetHeight || 90;
  m.style.left = `${clamp(x - w / 2, 10, window.innerWidth - w - 10)}px`;
  m.style.top = `${clamp(y - h - 18, 10, window.innerHeight - h - 10)}px`;
}
function hideItemMenu() {
  if (!menuItem) return;
  menuItem = null;
  $('#itemMenu').hidden = true;
}
$('#btnItemRemove').addEventListener('click', async () => {
  const id = menuItem;
  hideItemMenu();
  if (!id) return;
  layer.remove(id);
  try {
    await api.post('/api/draw/remove', { id });
  } catch (err) {
    if (err.status !== 404) toast('Couldn’t remove the drawing on the server.', { tone: 'error' });
  }
});
document.addEventListener('pointerdown', (e) => {
  if (menuItem && !(e.target instanceof Element && e.target.closest('#itemMenu'))) hideItemMenu();
}, true);

// ------------------------------------------------------------------ persistence of ink

let saveInFlight = false;
let saveAgain = false;
let saveFailures = 0;
const scheduleSave = debounce(saveStrokes, 700);

async function saveStrokes() {
  if (saveInFlight) {
    saveAgain = true;
    return;
  }
  saveInFlight = true;
  const body = JSON.stringify({ strokes: board.serialize(), client: CLIENT_ID });
  store.set('pendingStrokes', body.length < 4.5e6 ? body : null);
  try {
    await api.put('/api/strokes', body, { timeout: 45000 });
    store.remove('pendingStrokes');
    if (saveFailures >= 2) toast('Ink saved.');
    saveFailures = 0;
  } catch {
    saveFailures++;
    if (saveFailures === 2) toast('Can’t reach the server — your ink is kept on this device and will sync.', { tone: 'error' });
    setTimeout(() => scheduleSave(), Math.min(30000, 1500 * 2 ** saveFailures));
  } finally {
    saveInFlight = false;
    if (saveAgain) {
      saveAgain = false;
      scheduleSave();
    }
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
  store.set('lastSendAt', lastSendAt);
  updateInkChip();
  updateCaption();
  chat.setStatus('sending');
  outbox.set(cid, { text, image: snap.dataUrl, timeline, board_image_mode: snap.mode, cid, client_ts: clientTs });
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
  const b = $('#btnLayer');
  b.setAttribute('aria-pressed', String(prefs.layer));
  b.innerHTML = icon(prefs.layer ? 'sparkle' : 'sparkleOff');
}
$('#optLayer').addEventListener('change', (e) => setLayerVisible(e.target.checked));
$('#btnLayer').addEventListener('click', () => {
  setLayerVisible(!prefs.layer);
  hud(prefs.layer ? 'Claude’s drawings shown' : 'Claude’s drawings hidden', prefs.layer ? 'sparkle' : 'sparkleOff');
});
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

let resizeTimer = 0;
function onResize() {
  document.documentElement.classList.add('resizing');
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => document.documentElement.classList.remove('resizing'), 260);
  board.resize();
  chat.onViewportChange();
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
    scheduleSave.flush();
    saveCam.flush();
  }
});
window.addEventListener('pagehide', () => scheduleSave.flush());

// ------------------------------------------------------------------ server sync

function deriveLastSend(conversation) {
  let ts = 0;
  for (const m of conversation || []) if (m.role === 'user') ts = Math.max(ts, m.client_ts || m.ts || 0);
  return ts;
}

async function resync({ includeStrokes = false } = {}) {
  const st = await api.get('/api/state');
  chat.setConversation(st.conversation || []);
  layer.setAll(st.claude_layer || []);
  chat.setStatus(st.status || 'idle');
  if (!outbox.size) {
    lastSendAt = deriveLastSend(st.conversation);
    store.set('lastSendAt', lastSendAt);
  }
  if (includeStrokes) {
    const pending = store.get('pendingStrokes', null);
    let strokes = st.strokes || [];
    let restoredLocal = false;
    if (pending) {
      try {
        const parsed = JSON.parse(pending);
        if (Array.isArray(parsed.strokes)) {
          strokes = parsed.strokes;
          restoredLocal = true;
        }
      } catch { /* ignore */ }
    }
    board.load(strokes);
    if (restoredLocal) scheduleSave();
  }
  updateInkChip();
  updateSendReady();
  return st;
}

let pendingRemoteStrokes = false;
async function pullRemoteStrokes() {
  if (board.busy || saveInFlight) {
    pendingRemoteStrokes = true;
    return;
  }
  pendingRemoteStrokes = false;
  try {
    const st = await api.get('/api/state');
    board.load(st.strokes || []);
    updateInkChip();
  } catch { /* next event will retry */ }
}
setInterval(() => { if (pendingRemoteStrokes) pullRemoteStrokes(); }, 1500);

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

// ---- inside the iPad app (canvas/ios). It injects window.__canvasNative and runs speech on
// Apple's native engines (every installed voice, including Premium ones Safari hides).
const native = window.__canvasNative || null;
if (native) {
  $('#btnFullscreen').hidden = true;
  $('#menuApp').hidden = false;
  $('#btnServerLink').hidden = false;
  $('#btnServerLink').addEventListener('click', () => native.post('settings'));
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

let helloCount = 0;
events.addEventListener('hello', () => {
  helloCount++;
  if (helloCount > 1) resync().catch(() => {});
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
  // a main-agent reply while live: the talker says the gist out loud
  if (live.on && e.detail.source !== 'talker') live.onMainReply(e.detail.text);
});
events.addEventListener('talk', (e) => live.onTalkEvent(e.detail));
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
    toast(item.label ? `Claude drew “${item.label}”.` : 'Claude drew something.', {
      action: 'Show',
      onAction: () => {
        board.animateTo(board.cameraForRect(r, 120, board.cam.z));
        setTimeout(() => layer.flash(item.id), 360);
      },
    });
  }
});
events.addEventListener('draw_remove', (e) => e.detail && layer.remove(e.detail.id));
events.addEventListener('draw_clear', () => layer.clear());
events.addEventListener('strokes', (e) => {
  if (!e.detail || e.detail.client === CLIENT_ID) return;
  pullRemoteStrokes();
});

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
  const cam = store.get('cam', null);
  if (cam && Number.isFinite(cam.x) && Number.isFinite(cam.z)) board.setCamera(cam.x, cam.y, cam.z, { silent: true });
  $('#zoomLabel').textContent = `${Math.round(board.cam.z * 100)}%`;
}

async function boot() {
  applyTheme(initialTheme());
  restorePrefs();
  refreshToolbar();
  board.rightInset = chat.dockedWidth;
  layoutHint();
  if (!KEY) {
    $('#lockedMsg').textContent = 'Open the link that includes ?k=<key> (printed by server.py).';
    $('#locked').hidden = false;
  }
  try {
    const st = await resync({ includeStrokes: true });
    if (!board.strokes.length && !(st.conversation || []).length) showHint();
  } catch (err) {
    if (err.status === 401) {
      $('#lockedMsg').textContent = 'This link’s key was rejected. Open the URL printed by server.py.';
      $('#locked').hidden = false;
    } else {
      toast('Can’t reach the Canvas server — retrying…', { tone: 'error' });
      const pending = store.get('pendingStrokes', null);
      if (pending) {
        try { board.load(JSON.parse(pending).strokes || []); } catch { /* ignore */ }
      }
      setTimeout(() => resync({ includeStrokes: !board.strokes.length }).catch(() => {}), 3000);
    }
  }
  events.connect();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    app.classList.remove('booting');
    moveToolIndicator();
  }));
}

boot();
