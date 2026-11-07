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
    this.geo = Object.assign(
      { docked: true, width: window.innerWidth < 900 ? 336 : 384, left: null, top: null, height: null, collapsed: false, ghost: false, opacity: 1 },
      store.get('chat.geo', {}),
    );
    this._wire();
    this._applyGeo();
  }

  // ------------------------------------------------------------------ geometry

  _saveGeo() {
    store.set('chat.geo', this.geo);
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
    this._applyGeo();
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

    // drag by header; double-tap header to re-dock
    let lastTap = 0;
    this.head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, .pop')) return;
      const r = this.el.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height };
      let dragging = false;
      this.head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (!dragging && Math.hypot(dx, dy) > 6) {
          dragging = true;
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
          const r2 = this.el.getBoundingClientRect();
          if (window.innerWidth - r2.right < 28 && r2.top < 40) this.geo.docked = true; // snap back
          this._applyGeo();
          this._saveGeo();
        } else {
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

  setConversation(list) {
    const local = [...this.byCid.values()].filter((r) => r.msg.local && !r.msg.id);
    this.list.replaceChildren();
    this.byId.clear();
    this.byCid.clear();
    this.lastDay = '';
    for (const m of Array.isArray(list) ? list : []) this._append(m, false);
    for (const r of local) this._append(r.msg, false);
    this._updateEmpty();
    requestAnimationFrame(() => this._scrollToBottom(false));
  }

  add(msg, { animate = true } = {}) {
    if (msg.id && this.byId.has(msg.id)) return;
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

  _append(m, animate) {
    const ts = m.ts || Date.now();
    const day = fmtDay(ts);
    if (day !== this.lastDay) {
      this.lastDay = day;
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = day;
      this.list.appendChild(sep);
    }
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
