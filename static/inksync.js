// Ink sync: this page's strokes <-> the server, as changes (server.py, "ink as changes").
//
// - What changes here (board.takeOps) is queued, kept in storage until the server confirms it
//   (nothing drawn offline, or while the app moves to a new address, is lost), and sent in small
//   batches a moment after you lift the Pencil. A failed send is retried with growing pauses.
// - The server numbers every batch (a revision) and tells every page. Other pages apply it in
//   place: no reload of the whole board, and their undo history stays. A page that missed some
//   batches (asleep, reconnecting, the server restarted) asks for just those, or for the whole
//   board if it fell too far behind, and then puts its own unsent changes back on top.
import { api, SESSION, sessionKey } from './api.js';
import { store } from './util.js';
import { loadInk, saveInk } from './inkcache.js';

const opId = (o) => (o.op === 'del' ? o.id : o.s && o.s.id);

// Merge ops into what's stored for a board (later changes to a stroke win), or take some out.
function keepFor(key, ops) {
  const saved = store.get(key, null);
  const byId = new Map((Array.isArray(saved) ? saved : []).filter((o) => o && opId(o)).map((o) => [opId(o), o]));
  for (const o of ops) byId.set(opId(o), o);
  if (byId.size) store.set(key, [...byId.values()]);
}
function forgetFor(key, ops) {
  const saved = store.get(key, null);
  if (!Array.isArray(saved)) return;
  const sent = new Set(ops.map((o) => JSON.stringify(o)));
  const left = saved.filter((o) => !sent.has(JSON.stringify(o)));
  if (left.length) store.set(key, left);
  else store.remove(key);
}

export class InkSync extends EventTarget {
  constructor({ board, clientId }) {
    super();
    this.board = board;
    this.client = clientId;
    this.gen = 0;           // bumped when the page moves to another board: older replies are ignored
    this.copyTimer = 0;
    this.lastInput = 0;
    for (const t of ['pointerdown', 'pointermove']) window.addEventListener(t, () => { this.lastInput = Date.now(); }, { capture: true, passive: true });
    window.addEventListener('pagehide', () => this.saveCopy(true));
    this.timer = 0;
    this._bind(SESSION);
  }

  // Everything that belongs to one board.
  _bind(session) {
    this.session = session;
    this.rev = -1;          // the server revision this page's board matches (-1: not loaded yet)
    this.inkId = '';        // which board that revision belongs to (the server's id for it)
    this.key = sessionKey('pendingInk', session);
    this.copyKey = sessionKey('ink', session); // this device's copy of the board (inkcache.js)
    this.pending = [];      // changes not yet sent
    this.sending = null;    // the batch on its way
    this.failures = 0;
    this.catching = false;
    this.catchAgain = false;
    this.missedWhileLoading = false;
    this.started = null;
    const saved = store.get(this.key, null);
    if (Array.isArray(saved)) this.pending = saved.filter((o) => o && opId(o));
  }

  // Leave this board for another (app.js openBoard). What was drawn here is sent to this board
  // (waiting up to `wait` ms) and otherwise kept on this device for it; its copy is saved. Then
  // nothing of this board touches the page any more. Call start() for the new one.
  async switchTo(session, { wait = 1500 } = {}) {
    if (this.board.changed.size) this._queue(this.board.takeOps());
    this.saveCopy(true);
    if (this.pending.length && !this.sending && this.rev >= 0) {
      await Promise.race([this.flush(), new Promise((r) => setTimeout(r, wait))]).catch(() => {});
    }
    this._persist(); // whatever is still unsent (or on its way) stays stored under this board
    clearTimeout(this.timer);
    clearTimeout(this.copyTimer);
    this.gen++;
    this._bind(session);
  }

  // ---- outgoing

  // The board changed here: queue its changes and send them shortly.
  local() {
    const ops = this.board.takeOps();
    if (!ops.length) return;
    this._queue(ops);
    this._schedule(250);
    this._copySoon();
  }

  // ---- this device's copy of the board (for an instant start, and offline)

  // Saved a few seconds after the last change, only while you're not touching the board (a big
  // board takes a moment to copy), and when the page goes away.
  _copySoon() {
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.saveCopy(), 4000);
  }

  saveCopy(now = false) {
    if (this.rev < 0) return;
    if (!now && (this.board.busy || Date.now() - this.lastInput < 2500)) return this._copySoon();
    clearTimeout(this.copyTimer);
    saveInk(this.copyKey, { id: this.inkId, rev: this.rev, strokes: this.board.serialize(), at: Date.now() });
  }

  // Later changes to a stroke replace earlier unsent ones, keeping the first one's place in line
  // (so a stroke is always sent before the strokes drawn on top of it).
  _queue(ops) {
    const byId = new Map(this.pending.map((o) => [opId(o), o]));
    for (const o of ops) byId.set(opId(o), o);
    this.pending = [...byId.values()];
    this._persist();
  }

  _persist() {
    const all = (this.sending || []).concat(this.pending);
    if (all.length) store.set(this.key, all);
    else store.remove(this.key);
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), ms);
  }

  get unsent() {
    return this.pending.length + (this.sending ? this.sending.length : 0);
  }

  async flush() {
    clearTimeout(this.timer);
    if (this.board.changed.size) this._queue(this.board.takeOps());
    if (this.sending || !this.pending.length || this.rev < 0) return;
    const batch = this.pending;
    const { gen, session, key } = this; // the board this batch is for, even if the page moves on
    this.pending = [];
    this.sending = batch;
    try {
      const res = await api.post('/api/ink', { client: this.client, ops: batch }, { timeout: 30000, session });
      if (gen !== this.gen) return forgetFor(key, batch); // that board has it: not kept for it any more
      this.sending = null;
      if (res.rev === this.rev + 1) this.rev = res.rev; // else: others' batches are on their way first
      if (this.failures >= 2) this._emit('recovered');
      this.failures = 0;
      this._persist();
      if (this.pending.length) this._schedule(0);
    } catch (err) {
      if (gen !== this.gen) return keepFor(key, batch); // the page moved on: kept for that board
      this.sending = null;
      if (err.status === 400 || err.status === 404 || err.status === 413) {
        // the server will never take this batch (or the session is gone): don't loop forever
        console.warn('ink batch dropped', err);
        this._persist();
        return;
      }
      // back to the front of the line; newer changes to the same strokes still win
      const merged = new Map(batch.map((o) => [opId(o), o]));
      for (const o of this.pending) merged.set(opId(o), o);
      this.pending = [...merged.values()];
      this.failures++;
      this._persist();
      store.keep(this.key); // in the app, unsent ink also survives a change of address
      if (this.failures === 2) this._emit('trouble');
      this._schedule(Math.min(30000, 1500 * 2 ** this.failures));
    }
  }

  // ---- incoming

  // An `ink` event from the server.
  onEvent(ev) {
    if (!ev) return;
    if (this.rev < 0) { // still loading: look again right after
      this.missedWhileLoading = true;
      return;
    }
    if (ev.reset) return this.catchUp(true);
    if (ev.rev <= this.rev) return; // already have it (our own, or seen during a catch-up)
    if (ev.rev !== this.rev + 1) return this.catchUp(); // missed some
    if (ev.client !== this.client) this._apply(ev.ops);
    this.rev = ev.rev;
    this._copySoon();
  }

  _apply(ops) {
    // a stroke someone else changed that we're also changing: ours goes on top again
    this.board.applyRemote(ops);
    const mine = (this.sending || []).concat(this.pending).filter((o) => ops.some((x) => opId(x) === opId(o)));
    if (mine.length) this.board.applyRemote(mine);
  }

  // The board at start: this device's copy at once (if there is one), then only what changed
  // since; with no copy, the whole board from the server. Safe to call more than once.
  start() {
    if (!this.started) this.started = this._start();
    return this.started;
  }

  async _start() {
    const gen = this.gen;
    const copy = await loadInk(this.copyKey);
    if (gen !== this.gen) return; // another board was opened meanwhile
    if (copy && Array.isArray(copy.strokes) && this.rev < 0) {
      this.board.load(copy.strokes);
      const mine = (this.sending || []).concat(this.pending);
      if (mine.length) {
        this.board.applyRemote(mine);
        this.board.changed.clear();
      }
      this.rev = Number.isFinite(copy.rev) ? copy.rev : 0;
      this.inkId = copy.id || '';
      this.catchUp(); // in the background: the board is already on screen
      return;
    }
    await this.catchUp(true);
  }

  async catchUp(full = false) {
    if (this.catching) {
      this.catchAgain = this.catchAgain || (full ? 'full' : true);
      return;
    }
    this.catching = true;
    const { gen, session } = this;
    try {
      // hold remote changes while a stroke / move is in progress: apply them right after
      while (this.board.busy) await new Promise((r) => setTimeout(r, 120));
      if (gen !== this.gen) return;
      const since = full || this.rev < 0 ? -1 : this.rev;
      const res = await api.get(`/api/ink?since=${since}&id=${encodeURIComponent(this.inkId)}`, { timeout: 45000, session });
      if (gen !== this.gen) return; // another board was opened meanwhile: this one's ink isn't wanted
      if (Array.isArray(res.strokes)) this._loadAll(res);
      else {
        for (const b of res.batches || []) {
          if (b.rev <= this.rev) continue;
          if (b.client !== this.client) this._apply(b.ops);
          this.rev = b.rev;
        }
      }
      if (res.id) this.inkId = res.id;
      this._schedule(0);
      this._copySoon();
    } catch (err) {
      if (gen === this.gen) {
        if (this.rev < 0) this._emit('offline'); // couldn't load at all: the app shows what it has
        setTimeout(() => { if (gen === this.gen) this.catchUp(full); }, 4000);
      }
    } finally {
      // (a catch-up for a board the page has left changes nothing: _bind reset all of this)
      if (gen === this.gen) this._afterCatchUp();
    }
  }

  _afterCatchUp() {
    this.catching = false;
    if (this.missedWhileLoading && this.rev >= 0) {
      this.missedWhileLoading = false;
      this.catchAgain = this.catchAgain || true;
    }
    if (this.catchAgain) {
      const again = this.catchAgain;
      this.catchAgain = false;
      this.catchUp(again === 'full');
    }
  }

  // The server's whole board, with this page's unsent changes put back on top.
  _loadAll(res) {
    if (this.board.changed.size) this._queue(this.board.takeOps());
    this.board.load(res.strokes);
    const mine = (this.sending || []).concat(this.pending);
    if (mine.length) {
      this.board.applyRemote(mine);
      this.board.changed.clear(); // they're already queued
    }
    this.rev = Number.isFinite(res.rev) ? res.rev : 0;
    if (res.id) this.inkId = res.id;
  }

  // Offline at start: show at least what was drawn here and never sent.
  showUnsent() {
    const mine = this.pending.concat(this.sending || []);
    if (mine.length && !this.board.strokes.length) {
      this.board.applyRemote(mine);
      this.board.changed.clear();
    }
  }

  _emit(type) {
    this.dispatchEvent(new Event(type));
  }
}
