// Translucent chat overlay: conversation, status shimmer, composer, docking/drag/resize,
// collapse-to-pill, opacity and pass-through ("ghost") mode.
import { renderMarkdown } from './markdown.js';
import { icon } from './icons.js';
import { withKey } from './api.js';
import { $, clamp, fmtClock, fmtDay, store } from './util.js';

const WIDTHS = [336, 384, 480];
const MIN_W = 280;
const MIN_H = 260;

export class ChatPanel extends EventTarget {
  constructor() {
    super();
    this.el = $('#chat');
    this.head = $('#chatHead');
    this.scroller = $('#chatScroll');
    this.list = $('#messages');
    this.empty = $('#chatEmpty');
    this.typing = $('#typing');
    this.typingText = $('#typingText');
    this.jump = $('#jumpNew');
    this.pill = $('#chatPill');
    this.badge = $('#pillBadge');
    this.pillStatus = $('#pillStatus');
    this.conn = $('#conn');
    this.draft = $('#draft');
    this.interimEl = $('#interim');
    this.inkChip = $('#inkChip');
    this.modeSeg = $('#modeSeg');
    this.btnGhost = $('#btnGhost');
    this.btnOpacity = $('#btnOpacity');
    this.btnWidth = $('#btnWidthPreset');
    this.btnDock = $('#btnDock');
    this.btnCollapse = $('#btnCollapse');
    this.opacityPop = $('#opacityPop');
    this.opacityRange = $('#opacityRange');
    this.grip = $('#chatGrip');

    this.byId = new Map();
    this.byCid = new Map();
    this.unread = 0;
    this.lastDay = '';
    this.status = 'idle';
    // older messages load when you scroll to the top (the page starts with only the latest ones)
    this.more = false;
    this.loadingEarlier = false;
    this.moreEl = document.createElement('div');
    this.moreEl.className = 'chat-more';
    this.moreEl.textContent = 'Earlier messages';
    this._moreSeen = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) this._loadEarlier();
    }, { root: this.scroller, rootMargin: '400px 0px 0px 0px' });
    this._moreSeen.observe(this.moreEl);
    this.geo = Object.assign(
      { docked: true, width: window.innerWidth < 900 ? 336 : 384, left: null, top: null, height: null, collapsed: false, ghost: false, opacity: 1 },
      store.get('chat.geo', {}),
    );
    this._wire();
    this._refit(this.geo.vw, this.geo.vh); // saved on another screen size (the other orientation)
    this._vw = window.innerWidth;
    this._vh = window.innerHeight;
    this._applyGeo();
  }

  // ------------------------------------------------------------------ geometry

  _saveGeo() {
    this.geo.vw = window.innerWidth; // the screen it was placed on, for _refit
    this.geo.vh = window.innerHeight;
    store.set('chat.geo', this.geo);
  }

  // The screen changed size (the iPad turned): a floating panel that was fully on screen stays
  // fully on screen, on the side it was nearer to. One parked mostly off an edge on purpose stays
  // parked (_applyGeo keeps 120 px of it showing).
  _refit(oldVw, oldVh) {
    const g = this.geo;
    if (g.docked || g.left == null || g.top == null || !oldVw || !oldVh) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw === oldVw && vh === oldVh) return;
    const oldH = g.height || 520;
    const gapR = oldVw - (g.left + g.width), gapB = oldVh - (g.top + oldH);
    if (g.left < 0 || gapR < 0) return;
    const BOTTOM = 90; // the toolbar row, kept clear (as the docked panel does)
    const w = clamp(g.width, MIN_W, Math.max(MIN_W, vw - 24));
    const h = clamp(oldH, MIN_H, Math.max(MIN_H, vh - 8 - BOTTOM));
    const left = gapR < g.left ? vw - w - gapR : g.left;
    const top = gapB < g.top ? vh - h - Math.max(gapB, BOTTOM) : g.top;
    g.width = w;
    g.height = h;
    g.left = clamp(left, 8, Math.max(8, vw - w - 8));
    g.top = clamp(top, 8, Math.max(8, vh - h - BOTTOM));
  }

  get dockedWidth() {
    return this.geo.collapsed || !this.geo.docked ? 0 : this.el.offsetWidth + 12;
  }

  _applyGeo() {
    const g = this.geo;
    const el = this.el;
    const vw = window.innerWidth, vh = window.innerHeight;
    const maxW = Math.max(MIN_W, vw - 24);
    g.width = clamp(g.width || 384, MIN_W, Math.min(760, maxW));
    el.classList.toggle('docked', !!g.docked);
    el.classList.toggle('floating', !g.docked);
    if (g.docked) {
      el.style.left = el.style.top = el.style.height = '';
    } else {
      const h = clamp(g.height || 520, MIN_H, vh - 24);
      g.left = clamp(g.left ?? vw - g.width - 12, 8 - g.width + 120, vw - 120);
      g.top = clamp(g.top ?? 12, 8, vh - 64);
      el.style.left = `${g.left}px`;
      el.style.top = `${g.top}px`;
      el.style.height = `${h}px`;
      g.height = h;
    }
    el.style.width = `${g.width}px`;
    el.classList.toggle('collapsed', !!g.collapsed);
    this.pill.classList.toggle('show', !!g.collapsed);
    el.classList.toggle('ghost', !!g.ghost);
    this.btnGhost.classList.toggle('active', !!g.ghost);
    this.btnGhost.setAttribute('aria-pressed', String(!!g.ghost));
    this.btnDock.hidden = !!g.docked;
    this.btnWidth.hidden = !g.docked;
    const k = clamp(g.opacity ?? 1, 0.2, 1);
    el.style.setProperty('--glass-k', String(k));
    this.opacityRange.value = String(Math.round(k * 100));
    this.dispatchEvent(new CustomEvent('layout'));
  }

  setCollapsed(on) {
    this.geo.collapsed = !!on;
    if (!on) {
      this.unread = 0;
      this._renderBadge();
      requestAnimationFrame(() => this._scrollToBottom(false));
    }
    this._applyGeo();
    this._saveGeo();
  }

  toggleGhost() {
    this.geo.ghost = !this.geo.ghost;
    this._applyGeo();
    this._saveGeo();
    this.dispatchEvent(new CustomEvent('ghost', { detail: this.geo.ghost }));
  }

  cycleWidth() {
    const cur = this.geo.width;
    const next = WIDTHS.find((w) => w > cur + 4) || WIDTHS[0];
    this.geo.width = next;
    this._applyGeo();
    this._saveGeo();
  }

  dock() {
    this.geo.docked = true;
    this._applyGeo();
    this._saveGeo();
  }

  onViewportChange() {
    this._refit(this._vw, this._vh);
    this._vw = window.innerWidth;
    this._vh = window.innerHeight;
    this._applyGeo();
    if (!this.geo.docked) this._saveGeo();
  }

  _wire() {
    this.btnCollapse.addEventListener('click', () => this.setCollapsed(true));
    this.pill.addEventListener('click', () => this.setCollapsed(false));
    this.btnGhost.addEventListener('click', () => this.toggleGhost());
    this.btnWidth.addEventListener('click', () => this.cycleWidth());
    this.btnDock.addEventListener('click', () => this.dock());
    this.btnOpacity.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = this.opacityPop.hidden;
      this.opacityPop.hidden = !open;
      this.btnOpacity.classList.toggle('active', open);
    });
    this.opacityRange.addEventListener('input', () => {
      this.geo.opacity = clamp(+this.opacityRange.value / 100, 0.2, 1);
      this.el.style.setProperty('--glass-k', String(this.geo.opacity));
    });
    this.opacityRange.addEventListener('change', () => this._saveGeo());
    document.addEventListener('pointerdown', (e) => {
      if (!this.opacityPop.hidden && !this.opacityPop.contains(e.target) && !this.btnOpacity.contains(e.target)) {
        this.opacityPop.hidden = true;
        this.btnOpacity.classList.remove('active');
      }
    });

    // drag by the header, from anywhere on it: a press on one of its buttons that moves is a drag
    // (and doesn't press the button); one that doesn't move is a tap. Double-tap to re-dock.
    let lastTap = 0;
    this.head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input, .pop')) return;
      const onButton = !!e.target.closest('button');
      const r = this.el.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height };
      let dragging = false;
      // captured only once it's a drag: before that the button must still get its tap
      if (!onButton) this.head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (!dragging && Math.hypot(dx, dy) > 6) {
          dragging = true;
          try { this.head.setPointerCapture(e.pointerId); } catch { /* already released */ }
          this.geo.docked = false;
          this.geo.width = start.w;
          this.geo.height = start.h;
          this.el.classList.add('dragging');
        }
        if (dragging) {
          this.geo.left = start.left + dx;
          this.geo.top = start.top + dy;
          this._applyGeo();
        }
      };
      const up = () => {
        this.head.removeEventListener('pointermove', move);
        this.head.removeEventListener('pointerup', up);
        this.head.removeEventListener('pointercancel', up);
        this.el.classList.remove('dragging');
        if (dragging) {
          if (onButton) {
            // the drag started on a button: the tap the browser sends now isn't one
            const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
            window.addEventListener('click', swallow, { capture: true, once: true });
            setTimeout(() => window.removeEventListener('click', swallow, true), 400);
          }
          const r2 = this.el.getBoundingClientRect();
          if (window.innerWidth - r2.right < 28 && r2.top < 40) this.geo.docked = true; // snap back
          this._applyGeo();
          this._saveGeo();
        } else if (!onButton) {
          const now = performance.now();
          if (now - lastTap < 320) this.dock();
          lastTap = now;
        }
      };
      this.head.addEventListener('pointermove', move);
      this.head.addEventListener('pointerup', up);
      this.head.addEventListener('pointercancel', up);
    });

    // resize from the bottom-left grip
    this.grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, right: r.right, w: r.width, h: r.height, top: r.top };
      this.grip.setPointerCapture(e.pointerId);
      this.el.classList.add('dragging');
      const move = (ev) => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        const w = clamp(start.w - dx, MIN_W, Math.min(760, window.innerWidth - 24));
        this.geo.width = w;
        if (!this.geo.docked) {
          this.geo.left = start.right - w;
          this.geo.height = clamp(start.h + dy, MIN_H, window.innerHeight - start.top - 12);
        }
        this._applyGeo();
      };
      const up = () => {
        this.grip.removeEventListener('pointermove', move);
        this.grip.removeEventListener('pointerup', up);
        this.grip.removeEventListener('pointercancel', up);
        this.el.classList.remove('dragging');
        this._saveGeo();
      };
      this.grip.addEventListener('pointermove', move);
      this.grip.addEventListener('pointerup', up);
      this.grip.addEventListener('pointercancel', up);
    });

    this.scroller.addEventListener('scroll', () => {
      if (this._nearBottom()) this.jump.classList.remove('show');
    }, { passive: true });
    this.jump.addEventListener('click', () => this._scrollToBottom(true));

    // composer
    const grow = () => {
      this.draft.style.height = 'auto';
      this.draft.style.height = `${Math.min(this.draft.scrollHeight, 168)}px`;
      this._emitDraft();
    };
    this.draft.addEventListener('input', grow);
    this.draft.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.dispatchEvent(new CustomEvent('send'));
      }
    });
    this.draft.addEventListener('blur', () => {
      // iOS sometimes leaves the layout viewport scrolled after the keyboard closes
      setTimeout(() => { if (document.activeElement !== this.draft) window.scrollTo(0, 0); }, 60);
    });
    this._grow = grow;
    $('#btnClearDraft').addEventListener('click', () => this.dispatchEvent(new CustomEvent('cleardraft')));
    $('#btnSendInline').addEventListener('click', () => this.dispatchEvent(new CustomEvent('send')));
    this.modeSeg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (b) this.dispatchEvent(new CustomEvent('mode', { detail: b.dataset.mode }));
    });

    this.list.addEventListener('click', (e) => {
      const img = e.target.closest('img.thumb');
      if (img) {
        this.dispatchEvent(new CustomEvent('image', { detail: img.dataset.full || img.src }));
        return;
      }
      const retry = e.target.closest('[data-retry]');
      if (retry) this.dispatchEvent(new CustomEvent('retry', { detail: retry.dataset.retry }));
    });
  }

  // ------------------------------------------------------------------ composer API

  getDraft() {
    return this.draft.value;
  }

  setDraft(text) {
    this.draft.value = text;
    this._grow();
  }

  appendDraft(text) {
    const t = text.trim();
    if (!t) return;
    const cur = this.draft.value;
    const sep = !cur ? '' : /[\s\n]$/.test(cur) ? '' : ' ';
    this.draft.value = cur + sep + t;
    this._grow();
    this.draft.scrollTop = this.draft.scrollHeight;
  }

  setInterim(text) {
    this.interimEl.textContent = text || '';
    this.interimEl.classList.toggle('show', !!text);
    this._emitDraft();
  }

  setListening(on) {
    this.el.classList.toggle('listening', !!on);
    this.draft.placeholder = on ? 'Listening… speak while you draw' : 'Talk or type — then send to Claude';
  }

  setMode(mode) {
    for (const b of this.modeSeg.querySelectorAll('button')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.modeSeg.dataset.mode = mode;
  }

  setNewInk(n) {
    this.inkChip.textContent = n ? `${n} new stroke${n === 1 ? '' : 's'}` : 'No new ink';
    this.inkChip.classList.toggle('has', n > 0);
  }

  _emitDraft() {
    this.dispatchEvent(new CustomEvent('draft', { detail: { text: this.draft.value, interim: this.interimEl.textContent } }));
  }

  // ------------------------------------------------------------------ messages

  // The server's latest chat entries. Already showing some of them (a reconnect): keep every
  // bubble as it is and add only the new ones; nothing is re-rendered, the scroll stays put.
  // Otherwise (first load, another session, or entries arriving out of order): rebuild.
  setConversation(list, { more = false } = {}) {
    list = Array.isArray(list) ? list : [];
    const known = list.filter((m) => m.id && this.byId.has(m.id));
    if (!known.length || !this.byId.size) return this._rebuild(list, more);
    const newest = Math.max(...[...this.byId.values()].map((r) => r.msg.ts || 0));
    const fresh = list.filter((m) => !(m.id && this.byId.has(m.id)));
    if (fresh.some((m) => !(m.cid && this.byCid.has(m.cid)) && (m.ts || 0) < newest)) return this._rebuild(list, more);
    const near = this._nearBottom();
    for (const m of fresh) this.add(m, { animate: false });
    this._updateEmpty();
    if (near && fresh.length) requestAnimationFrame(() => this._scrollToBottom(false));
  }

  // Another board: forget this one's messages, unsent ones included (each board keeps its own
  // outbox; app.js shows the new board's). setConversation then builds the new board's chat.
  reset() {
    this.byCid.clear();
    this.loadingEarlier = false;
    this.moreEl.classList.remove('loading');
    this._rebuild([], false);
  }

  _rebuild(list, more) {
    const local = [...this.byCid.values()].filter((r) => r.msg.local && !r.msg.id);
    this.list.replaceChildren();
    this.byId.clear();
    this.byCid.clear();
    this.lastDay = '';
    this.activity = null;
    this.more = !!more;
    if (this.more) this.list.appendChild(this.moreEl);
    for (const m of list) this._append(m, false);
    for (const r of local) this._append(r.msg, false);
    this._updateEmpty();
    requestAnimationFrame(() => this._scrollToBottom(false));
  }

  // Scrolled up to the top: ask the app for the page before the oldest entry shown.
  _loadEarlier() {
    if (!this.more || this.loadingEarlier) return;
    const first = [...this.byId.values()].reduce((a, r) => (!a || (r.msg.ts || 0) < (a.msg.ts || 0) ? r : a), null);
    if (!first || !first.msg.id) return;
    this.loadingEarlier = true;
    this.moreEl.classList.add('loading');
    this.dispatchEvent(new CustomEvent('loadEarlier', { detail: { before: first.msg.id } }));
  }

  // Older entries go on top; what you were reading stays exactly where it was on screen.
  prependOlder(list, more) {
    this.loadingEarlier = false;
    this.moreEl.classList.remove('loading');
    this.more = !!more;
    list = (Array.isArray(list) ? list : []).filter((m) => !(m.id && this.byId.has(m.id)));
    if (!list.length) {
      if (!this.more) this.moreEl.remove();
      return;
    }
    // render the older page into its own container with the usual separators and step groups
    const saved = { list: this.list, lastDay: this.lastDay, activity: this.activity };
    const box = document.createElement('div');
    this.list = box;
    this.lastDay = '';
    this.activity = null;
    for (const m of list) this._append(m, false);
    this._closeActivity();
    const lastDayOfOlder = this.lastDay;
    Object.assign(this, saved);
    const s = this.scroller;
    const h0 = s.scrollHeight, top0 = s.scrollTop; // measured before anything above changes
    // the day heading where the two pages meet would repeat: keep the older one
    const firstOld = [...this.list.children].find((n) => n !== this.moreEl);
    if (firstOld && firstOld.classList.contains('day-sep') && firstOld.textContent === lastDayOfOlder) firstOld.remove();
    if (this.more) {
      this.list.insertBefore(box, this.moreEl.nextSibling); // the marker stays on top: more to come
    } else {
      this.moreEl.remove(); // that was the beginning of the chat
      this.list.insertBefore(box, this.list.firstChild);
    }
    box.replaceWith(...box.childNodes);
    s.scrollTop = top0 + (s.scrollHeight - h0);
  }

  // Loading the older page failed: let the next scroll to the top try again.
  earlierFailed() {
    this.loadingEarlier = false;
    this.moreEl.classList.remove('loading');
  }

  add(msg, { animate = true } = {}) {
    if (msg.id && this.byId.has(msg.id)) return;
    if (msg.kind === 'progress') {
      const near = this._nearBottom();
      this._append(msg, animate);
      if (near) this._scrollToBottom(true);
      return;
    }
    if (msg.cid && this.byCid.has(msg.cid)) {
      this.update(msg.cid, { ...msg, local: false, state: 'sent' });
      return;
    }
    const near = this._nearBottom();
    this._append(msg, animate);
    this._updateEmpty();
    if (msg.role === 'claude') {
      if (this.geo.collapsed) {
        this.unread++;
        this._renderBadge();
        this.pill.classList.remove('bump');
        void this.pill.offsetWidth;
        this.pill.classList.add('bump');
      }
      if (near || this.geo.collapsed) this._scrollToBottom(true);
      else this.jump.classList.add('show');
    } else {
      this._scrollToBottom(true);
    }
  }

  update(cid, patch) {
    const rec = this.byCid.get(cid);
    if (!rec) return;
    Object.assign(rec.msg, patch);
    if (patch.id) this.byId.set(patch.id, rec);
    const fresh = this._renderMsg(rec.msg, false);
    rec.el.replaceWith(fresh);
    rec.el = fresh;
  }

  // Progress notes (what the agent is doing, one short line each) gather into an activity block
  // above its next message. While it works the block is open; any real message closes it into
  // "N steps", which expands on tap.
  _appendProgress(m, animate) {
    if (!this.activity) {
      this._daySep(m.ts || Date.now());
      const block = document.createElement('div');
      block.className = 'activity open';
      const head = document.createElement('button');
      head.className = 'activity-head';
      head.type = 'button';
      head.addEventListener('click', () => block.classList.toggle('expanded'));
      const steps = document.createElement('div');
      steps.className = 'steps';
      block.append(head, steps);
      this.list.appendChild(block);
      this.activity = { block, head, steps, n: 0 };
    }
    const a = this.activity;
    const step = document.createElement('div');
    step.className = `step${animate ? ' enter' : ''}`;
    const text = document.createElement('span');
    text.className = 'step-text';
    text.textContent = (m.text || '').trim();
    const t = document.createElement('time');
    t.textContent = fmtClock(m.ts || Date.now());
    step.append(text, t);
    a.steps.appendChild(step);
    a.n += 1;
    a.head.textContent = `Working · ${a.n} step${a.n === 1 ? '' : 's'}`;
    if (m.id) this.byId.set(m.id, { msg: m, el: step });
  }

  _daySep(ts) {
    const day = fmtDay(ts);
    if (day === this.lastDay) return;
    this.lastDay = day;
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = day;
    this.list.appendChild(sep);
  }

  _closeActivity() {
    const a = this.activity;
    if (!a) return;
    a.block.classList.remove('open');
    a.head.textContent = `${a.n} step${a.n === 1 ? '' : 's'}`;
    this.activity = null;
  }

  _append(m, animate) {
    if (m.kind === 'progress') {
      this._appendProgress(m, animate);
      return;
    }
    this._closeActivity();
    this._daySep(m.ts || Date.now());
    const el = this._renderMsg(m, animate);
    this.list.appendChild(el);
    const rec = { msg: m, el };
    if (m.id) this.byId.set(m.id, rec);
    if (m.cid) this.byCid.set(m.cid, rec);
  }

  _renderMsg(m, animate) {
    const row = document.createElement('div');
    row.className = `msg ${m.role === 'claude' ? 'claude' : 'user'}${animate ? ' enter' : ''}`;
    if (m.role === 'claude') {
      const av = document.createElement('div');
      av.className = 'avatar';
      av.innerHTML = icon('claude');
      const bubble = document.createElement('div');
      bubble.className = 'bubble md';
      bubble.innerHTML = renderMarkdown(m.text || '');
      const wrap = document.createElement('div');
      wrap.className = 'stack';
      wrap.append(bubble, this._meta(m));
      row.append(av, wrap);
      return row;
    }
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    const src = m.thumb || (m.image ? withKey(m.image) : null);
    if (src) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = 'Snapshot sent to Claude';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.src = src;
      img.dataset.full = m.full || (m.image ? withKey(m.image) : src);
      if (m.width && m.height) img.style.aspectRatio = `${m.width} / ${m.height}`;
      wrap.appendChild(img);
    }
    if (m.text && m.text.trim()) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.text.trim();
      wrap.appendChild(bubble);
    }
    wrap.appendChild(this._meta(m));
    row.appendChild(wrap);
    return row;
  }

  _meta(m) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (m.state === 'sending') {
      meta.innerHTML = '<span class="spin"></span>Sending…';
    } else if (m.state === 'failed') {
      meta.classList.add('failed');
      meta.innerHTML = `Not delivered · <button class="link" data-retry="${m.cid}">Retry</button>`;
    } else {
      const t = document.createElement('time');
      t.textContent = fmtClock(m.ts || Date.now());
      meta.appendChild(t);
      if (m.role !== 'claude' && m.mode === 'board') {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'whole board';
        meta.appendChild(tag);
      }
      if (m.role !== 'claude' && m.source === 'chat') {
        // typed in Claude Code (terminal, VS Code, the Claude app), mirrored here
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'in Claude Code';
        meta.appendChild(tag);
      }
    }
    return meta;
  }

  _updateEmpty() {
    this.empty.hidden = this.list.querySelector('.msg') !== null;
  }

  _nearBottom() {
    const s = this.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 90;
  }

  _scrollToBottom(smooth) {
    const s = this.scroller;
    s.scrollTo({ top: s.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    this.jump.classList.remove('show');
  }

  _renderBadge() {
    this.badge.textContent = this.unread > 9 ? '9+' : String(this.unread);
    this.badge.classList.toggle('show', this.unread > 0);
  }

  // ------------------------------------------------------------------ status + connection

  setStatus(raw) {
    const v = String((raw && raw.status) || raw || 'idle').trim();
    const low = v.toLowerCase();
    let text = '';
    if (low === 'idle' || low === 'done' || low === '') text = '';
    else if (low === 'thinking' || low === 'sent') text = 'Claude is thinking…';
    else if (low === 'sending') text = 'Sending…';
    else text = v;
    this.status = text ? low : 'idle';
    const on = !!text;
    if (on) this.typingText.textContent = text;
    this.typing.classList.toggle('show', on);
    this.pillStatus.classList.toggle('show', on);
    this.el.classList.toggle('busy', on);
    if (on && this._nearBottom()) requestAnimationFrame(() => this._scrollToBottom(true));
  }

  setConnection(state) {
    const map = {
      open: ['ok', 'Connected'],
      connecting: ['wait', 'Connecting…'],
      reconnecting: ['wait', 'Reconnecting…'],
      offline: ['down', 'Offline'],
    };
    const [cls, label] = map[state] || ['wait', 'Connecting…'];
    this.conn.dataset.state = cls;
    this.conn.title = label;
    this.conn.setAttribute('aria-label', label);
    $('#connLabel').textContent = cls === 'ok' ? '' : label;
    this.pill.dataset.conn = cls;
  }
}
