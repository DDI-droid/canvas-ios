// Live voice conversation (the orb next to Send). Built from one design: see the
// "Live voice, redesigned" diagram on the board and the canvas skill.
//
//   Ears   Apple's recogniser (Safari Web Speech). One continuous session that survives iOS
//          ending it, so your words build up across pauses into one draft. It only starts
//          afresh after Haiku answered, after Claude's voice spoke (to drop its echo), or when
//          the draft is dismissed or expires.
//   Turns  at every pause (0.7 s; 0.5 s after . ? !) the whole draft goes to Haiku. Haiku acts
//          only through tools: speak | look_at_board | hand_off | dismiss, or does nothing
//          (you seem mid-thought: the draft is kept for 12 s). If you go on before it answers,
//          that turn is cancelled and the longer draft goes at the next pause ("continued").
//          Tapping the orb sends the draft now and tells Haiku you're done.
//   Mouth  Apple voices (speechSynthesis), sentence by sentence as they stream. Talking over
//          it (3+ words it didn't say) stops it at once; your words become the next draft.
//   Main   hand_off sends a 🎙 message to the main agent; its chat reply comes back here and
//          Haiku speaks the gist when you're quiet.
// The chat panel is the main agent's: voice turns aren't added to it (server: data/voice.log).
import { api } from './api.js';

const PAUSE_MS = 700;             // a pause this long sends the draft
const PAUSE_AFTER_PUNCT_MS = 500; // ...shorter when the recogniser closed the sentence (. ? !)
const HOLD_MS = 12000;            // an unanswered draft is kept this long in case you go on
const KEEP_WARM_MS = 240000;      // ping Haiku after 4 idle minutes so its prompt cache stays warm
const ECHO_GRACE_MS = 1200;       // just after the voice stops, words it said are still echo
const BARGE_IN_WORDS = 3;         // words it didn't say that count as talking over it
const SPEECH_RATE = 1.0;          // Apple's natural voices sound best at their own pace
const FILLER = /^(?:u+m+|u+h+|h+m+|m+h*m*|a+h+|e+r+|o+h+)[.!?,]*$/i;
const PREFERRED_VOICES = ['ava', 'zoe', 'evan', 'nathan', 'samantha', 'allison', 'susan', 'tom', 'daniel', 'karen'];
const REGION = { 'en-us': 'US', 'en-gb': 'UK', 'en-au': 'Australia', 'en-in': 'India', 'en-ie': 'Ireland', 'en-za': 'South Africa', 'en-nz': 'New Zealand', 'en-ca': 'Canada', 'en-sg': 'Singapore' };
const NOVELTY = /(novelty|bells|bubbles|whisper|zarvox|trinoids|organ|bahh|boing|cellos|jester|superstar|wobble|albert|bad news|good news|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley)/;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

const words = (s) => (s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const now = () => performance.now();
const newTurnId = () => 't-' + Math.random().toString(36).slice(2, 12);

// The device's English voices, most natural first. Apple's "Premium" and "Enhanced" voices
// (Settings › Accessibility › Read & Speak › Voices) sound far better than the defaults.
// Siri's own voices aren't available to web pages.
export function rankVoices() {
  const all = (window.speechSynthesis?.getVoices() || []).filter((v) => /^en(-|_|$)/i.test(v.lang));
  return all.map((v) => {
    const name = v.name.toLowerCase();
    let score = 0;
    const quality = name.includes('premium') ? 'Premium' : name.includes('enhanced') ? 'Enhanced' : '';
    if (quality === 'Premium') score += 6;
    if (quality === 'Enhanced') score += 4;
    if (PREFERRED_VOICES.some((p) => name.startsWith(p))) score += 2;
    if (/en[-_]us/i.test(v.lang)) score += 1;
    if (v.localService) score += 0.5;
    if (NOVELTY.test(name)) score -= 10;
    return {
      voice: v, name: v.name, score, quality,
      label: v.name.replace(/\s*\((premium|enhanced)\)\s*/i, ' ').trim(),
      region: REGION[v.lang.toLowerCase().replace('_', '-')] || v.lang,
    };
  }).filter((x) => x.score > -5).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

// Everything one recognition session has heard. iOS sometimes repeats earlier results
// cumulatively inside a later one; keep the longer version instead of doubling it.
function sessionText(results) {
  let full = '';
  for (let i = 0; i < results.length; i++) {
    const t = ((results[i][0] && results[i][0].transcript) || '').trim();
    if (!t) continue;
    if (full && t.toLowerCase().startsWith(full.toLowerCase())) full = t;
    else full = full ? `${full} ${t}` : t;
  }
  return full.replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------------------- ears
// One continuous recognition session. iOS ends sessions by itself (silence, about a minute):
// we keep what it heard and start the next one at once, and never give up while live.
class Ears extends EventTarget {
  constructor() {
    super();
    this.on = false;
    this.lang = 'en-US';
    this.kept = '';      // heard in earlier sessions of this draft
    this.current = '';   // the running session's transcript (Apple keeps refining it)
    this.base = 0;       // leading words to skip: Claude's own voice, heard before you spoke
    this.rec = null;
    this.quick = 0;      // sessions in a row that ended at once (back off a little)
    this.timer = 0;
  }

  get full() { return `${this.kept} ${this.current}`.replace(/\s+/g, ' ').trim(); }

  get text() {
    const full = this.full;
    return this.base && full ? full.split(' ').slice(this.base).join(' ') : full;
  }

  // Skip everything heard so far without restarting (a restart could swallow the first words
  // of a quick reply). Used when Claude's voice stops: what the mic heard was its echo.
  mark() {
    this.base = this.full ? this.full.split(' ').length : 0;
  }

  start(lang) {
    if (!SR) return false;
    if (lang) this.lang = lang;
    this.on = true;
    this.quick = 0;
    if (!this.rec) this.spawn();
    return true;
  }

  stop() {
    this.on = false;
    clearTimeout(this.timer);
    this.kill();
    this.kept = '';
    this.current = '';
    this.base = 0;
  }

  // Forget what was heard and listen afresh. A new session, because the old one may still be
  // holding (and revising) words we're throwing away, such as Claude's own voice.
  reset() {
    this.kept = '';
    this.current = '';
    this.base = 0;
    this.emit();
    if (!this.on) return;
    this.kill();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.on && !this.rec) this.spawn(); }, 120);
  }

  kill() {
    const r = this.rec;
    this.rec = null;
    if (!r) return;
    r.dead = true;
    try { r.abort(); } catch { /* ignore */ }
  }

  spawn() {
    clearTimeout(this.timer);
    let rec;
    try { rec = new SR(); } catch { this.fail('Speech recognition could not start.'); return; }
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.dead = false;
    rec.got = false;
    rec.at = now();
    this.rec = rec;
    rec.onresult = (e) => {
      if (rec.dead) return;
      rec.got = true;
      this.quick = 0;
      this.current = sessionText(e.results);
      this.emit();
    };
    rec.onerror = (e) => {
      if (rec.dead) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.on = false;
        this.kill();
        this.fail('The microphone or speech recognition is blocked. Allow it for this site in Safari, and make sure Dictation is on in Settings.');
      } else if (e.error === 'language-not-supported') {
        this.on = false;
        this.kill();
        this.fail(`Speech recognition doesn't support ${this.lang} here.`);
      }
      // no-speech, aborted, network, audio-capture: onend restarts us
    };
    rec.onend = () => {
      if (rec.dead) return;
      this.rec = null;
      if (this.current) {
        this.kept = `${this.kept} ${this.current}`.trim();
        this.current = '';
      }
      if (!this.on) return;
      const quick = now() - rec.at < 1500 && !rec.got;
      this.quick = quick ? this.quick + 1 : 0;
      const delay = quick ? Math.min(3000, 200 * 2 ** Math.min(this.quick, 4)) : 50;
      this.timer = setTimeout(() => { if (this.on && !this.rec) this.spawn(); }, delay);
    };
    try {
      rec.start();
    } catch {
      rec.dead = true;
      this.rec = null;
      this.quick++;
      this.timer = setTimeout(() => { if (this.on && !this.rec) this.spawn(); }, 400);
    }
  }

  emit() { this.dispatchEvent(new CustomEvent('text', { detail: this.text })); }
  fail(message) { this.dispatchEvent(new CustomEvent('error', { detail: message })); }
}

// ------------------------------------------------------------------------------ mouth
class Mouth extends EventTarget {
  constructor() {
    super();
    this.queue = [];
    this.speaking = false;
    this.current = '';       // sentence being spoken
    this.said = '';          // what it has said of the current reply (for [cut off])
    this.recent = '';        // its recent words, to recognise its own echo
    this.endedAt = 0;
    this.voiceName = '';     // chosen in ☰ › Voice; '' = the most natural one available
    this.voiceObj = null;
    this.watchdog = 0;
    window.speechSynthesis?.addEventListener?.('voiceschanged', () => { this.voiceObj = null; });
  }

  get supported() { return 'speechSynthesis' in window; }

  // iOS lets a page speak only after a tap has started speech once.
  unlock() {
    if (!this.supported) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  setVoiceName(name) {
    this.voiceName = name || '';
    this.voiceObj = null;
  }

  pick() {
    if (this.voiceObj) return this.voiceObj;
    const ranked = rankVoices();
    const chosen = this.voiceName && ranked.find((x) => x.name === this.voiceName);
    this.voiceObj = (chosen || ranked[0] || {}).voice || null;
    return this.voiceObj;
  }

  utter(text) {
    const u = new SpeechSynthesisUtterance(text);
    const v = this.pick();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = SPEECH_RATE;
    return u;
  }

  say(sentence) {
    const s = (sentence || '').trim();
    if (!s || !this.supported) return;
    this.queue.push(s);
    this.recent = `${this.recent} ${s}`.split(/\s+/).slice(-80).join(' ');
    if (!this.speaking) this.next();
  }

  next() {
    clearTimeout(this.watchdog);
    const s = this.queue.shift();
    if (!s) {
      this.speaking = false;
      this.current = '';
      this.endedAt = now();
      this.dispatchEvent(new Event('done'));
      return;
    }
    this.speaking = true;
    this.current = s;
    const u = this.utter(s);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      this.said = `${this.said} ${s}`.trim();
      if (this.speaking && this.current === s) this.next();
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
    this.watchdog = setTimeout(done, 2500 + s.length * 95); // iOS sometimes never fires onend
    this.dispatchEvent(new Event('line'));
  }

  // Stop at once. Returns what it had said of this reply, if it was speaking.
  stop() {
    const was = this.speaking;
    const cut = `${this.said} ${this.current ? this.current + '…' : ''}`.trim();
    clearTimeout(this.watchdog);
    this.queue = [];
    this.speaking = false;
    this.current = '';
    this.endedAt = now();
    if (this.supported) {
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
    }
    return was ? cut : '';
  }

  preview(name) {
    if (!this.supported) return;
    this.stop();
    this.setVoiceName(name);
    speechSynthesis.speak(this.utter('Hi. This is how I’ll sound when we talk.'));
  }
}

// -------------------------------------------------------------------- the conversation
export class Live extends EventTarget {
  constructor({ voiceSupported, snapshot, sendToMain, toast }) {
    super();
    this.supported = !!(voiceSupported && SR);
    this.snapshot = snapshot;     // async () => JPEG data URL of the current view
    this.sendToMain = sendToMain; // (task, heard) => void
    this.toast = toast;
    this.ears = new Ears();
    this.mouth = new Mouth();
    this.active = false;
    this.state = 'off';           // off | listening | hearing | thinking | looking | speaking
    this.heardWords = 0;          // words in the draft, to spot it growing
    this.grewAt = 0;
    this.sent = null;             // {text, words}: the draft Haiku has and hasn't answered
    this.heldAt = 0;              // Haiku chose to wait for more
    this.turn = null;             // {id, kind, text, lastN, answered, done}
    this.echoInDraft = false;     // the draft started while the voice was talking
    this.cutoff = '';             // what the voice had said when you talked over it
    this.lastHeard = '';
    this.working = null;          // {task, since} while the main agent works on a hand-off
    this.pendingMain = [];        // main-agent replies waiting for a quiet moment
    this.lastTurnAt = 0;
    this.cleanAt = 0;             // when to restart the recogniser to drop the voice's echo
    this.timer = 0;
    this.lookBusy = false;
    this.ears.addEventListener('text', (e) => this.onWords(e.detail));
    this.ears.addEventListener('error', (e) => this.toast(e.detail, { tone: 'error', ms: 6500 }));
    this.mouth.addEventListener('line', () => this.set('speaking'));
    this.mouth.addEventListener('done', () => this.afterSpeech());
  }

  get on() { return this.active; }
  setVoiceName(name) { this.mouth.setVoiceName(name); }
  preview(name) { this.mouth.preview(name); }

  // ---- lifecycle (start must run inside a tap: iOS unlocks speech and the mic there)
  start(lang) {
    if (this.active) return;
    if (!this.supported) {
      this.toast('Speech recognition isn’t available here, so live conversation can’t start.', { tone: 'error', ms: 5200 });
      return;
    }
    this.mouth.unlock();
    this.active = true;
    this.clearDraft(false);
    this.ears.start(lang);
    api.post('/api/talk', { kind: 'warmup' }, { timeout: 15000 }).catch(() => {});
    this.lastTurnAt = now();
    this.timer = setInterval(() => this.tick(), 90);
    this.set('listening');
    setTimeout(() => this.reportVoices(), 1500);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    this.cancelTurn();
    this.mouth.stop();
    this.ears.stop();
    this.clearDraft(false);
    this.cutoff = '';
    this.pendingMain = [];
    this.set('off');
  }

  // Tap on the orb: stop the voice if it's talking; otherwise "I'm done, answer now".
  tap() {
    if (!this.active) return;
    if (this.mouth.speaking) {
      this.bargeIn();
      return;
    }
    const text = this.ears.text;
    if (text) this.sendDraft(text, true);
  }

  // ---- your words (every recogniser update: the whole draft so far)
  onWords(text) {
    if (!this.active) return;
    if (this.mouth.speaking) {
      if (this.newWords(text) < BARGE_IN_WORDS) return; // its own voice
      this.bargeIn();
    } else if (text && this.isEcho(text)) {
      return; // the tail of its voice, just after it stopped
    }
    const n = words(text).length;
    if (n > this.heardWords) {
      this.grewAt = now();
      // You went on after a pause: an answer to the shorter draft would be stale.
      if (this.sent && n > this.sent.words) this.wentOn();
    }
    this.heardWords = n;
    if (!this.mouth.speaking && n > (this.sent ? this.sent.words : 0)) this.set('hearing');
    else this.emit();
  }

  wentOn() {
    this.heldAt = 0;
    const t = this.turn;
    if (t && t.kind === 'utterance' && !t.answered) this.cancelTurn();
  }

  // ---- the beat
  tick() {
    if (!this.active) return;
    const t = now();
    if (this.cleanAt && t > this.cleanAt && !this.mouth.speaking) {
      this.cleanAt = 0;
      if (!this.ears.text) this.ears.reset(); // you stayed quiet: drop the echo for good
    }
    const text = this.ears.text;
    if (text && !this.mouth.speaking) {
      if (!this.sent || words(text).length > this.sent.words) {
        const wait = /[.?!]$/.test(text) ? PAUSE_AFTER_PUNCT_MS : PAUSE_MS;
        if (t - this.grewAt >= wait) this.sendDraft(text, false);
      } else if (this.heldAt && t - this.heldAt > HOLD_MS) {
        this.clearDraft(true); // nobody followed up on it
        this.set('listening');
      }
    } else if (!text && !this.mouth.speaking && !this.busy() && this.pendingMain.length) {
      this.ask({ kind: 'main_reply', text: this.pendingMain.shift() });
    }
    if (this.working) this.emit(); // keeps the "working · 0:12" clock moving
    if (t - this.lastTurnAt > KEEP_WARM_MS && !this.busy() && !text) {
      this.lastTurnAt = t;
      api.post('/api/talk', { kind: 'warmup' }, { timeout: 15000 }).catch(() => {});
    }
  }

  busy() { return !!(this.turn && !this.turn.done); }

  // ---- turns
  sendDraft(raw, done) {
    const n = words(raw).length;
    const text = this.stripEcho(raw);
    if (!done && (!text || FILLER.test(text))) {
      this.sent = { text: '', words: n }; // just "um": keep it, you may go on
      this.heldAt = now();
      this.set('listening');
      return;
    }
    if (!text) return;
    const continued = !!(this.sent && this.sent.text);
    this.sent = { text, words: n };
    this.heldAt = 0;
    this.lastHeard = text;
    this.ask({ kind: 'utterance', text, continued, done, interrupted: this.cutoff });
  }

  async ask(body) {
    this.cancelTurn();
    const turn = { id: newTurnId(), kind: body.kind, text: body.text, lastN: 0, answered: false, done: false };
    this.turn = turn;
    this.lastTurnAt = now();
    this.set('thinking');
    let res;
    try {
      res = await api.post('/api/talk', { ...body, turn: turn.id }, { timeout: 65000 });
    } catch (err) {
      if (this.turn !== turn) return;
      turn.done = true;
      this.toast(err.status === 503 ? 'The voice talker isn’t available on the server.' : 'The voice talker didn’t answer.', { tone: 'error' });
      if (!this.mouth.speaking) this.set('listening');
      return;
    }
    if (this.turn !== turn) return;
    for (const ev of (res.events || []).sort((a, b) => a.n - b.n)) this.handle(ev);
  }

  // Drop the current turn: the server skips it if queued and interrupts Haiku if running.
  cancelTurn() {
    const turn = this.turn;
    this.turn = null;
    if (!turn || turn.done) return;
    turn.done = true;
    api.post('/api/talk/cancel', { turn: turn.id }).catch(() => {});
    if (turn.kind === 'main_reply' && !turn.answered) this.pendingMain.unshift(turn.text);
  }

  onTalkEvent(ev) {
    if (ev && this.turn && ev.turn === this.turn.id) this.handle(ev);
  }

  handle(ev) {
    const turn = this.turn;
    if (!turn || !(ev.n > turn.lastN)) return;
    turn.lastN = ev.n;
    if (ev.say || ev.handoff) this.answered(turn);
    if (ev.say) this.mouth.say(ev.say);
    if (ev.look) this.uploadBoard();
    if (ev.handoff) {
      this.working = { task: ev.handoff, since: Date.now() };
      try { this.sendToMain(ev.handoff, this.lastHeard); } catch (e) { console.error(e); }
    }
    if (ev.dismiss && turn.kind === 'utterance') this.clearDraft(true);
    if (ev.done) {
      turn.done = true;
      if (ev.error) this.toast('The voice talker hit an error.', { tone: 'error' });
      // It said nothing: you seem mid-thought, so your words are kept for a while.
      if (turn.kind === 'utterance' && !turn.answered && this.sent) this.heldAt = now();
      if (!this.mouth.speaking) {
        const more = this.ears.text && (!this.sent || words(this.ears.text).length > this.sent.words);
        this.set(more ? 'hearing' : 'listening');
      }
    }
  }

  // Haiku answered your words: the next thing you say starts a new draft.
  answered(turn) {
    if (turn.answered) return;
    turn.answered = true;
    this.mouth.said = '';
    if (turn.kind === 'utterance') {
      this.cutoff = '';
      this.clearDraft(true);
    }
  }

  clearDraft(resetEars) {
    this.sent = null;
    this.heldAt = 0;
    this.heardWords = 0;
    this.echoInDraft = false;
    if (resetEars) {
      this.cleanAt = 0;
      this.ears.reset();
    }
  }

  // look_at_board: Haiku waits (server side) for this picture.
  async uploadBoard() {
    if (this.lookBusy) return;
    this.lookBusy = true;
    if (!this.mouth.speaking) this.set('looking');
    try {
      const image = await this.snapshot();
      await api.post('/api/talk/board', { image }, { timeout: 20000 });
    } catch { /* Haiku is told the picture didn't arrive */ }
    this.lookBusy = false;
    if (this.state === 'looking') this.set('thinking');
  }

  onMainReply(text) {
    if (!this.active || !text) return;
    this.working = null;
    this.pendingMain.push(text);
    this.emit();
  }

  // ---- talking over it, and its echo
  bargeIn() {
    const cut = this.mouth.stop();
    if (cut) this.cutoff = cut;
    this.cancelTurn(); // stop it generating more
    this.echoInDraft = true;
    this.set('hearing');
  }

  // The voice finished on its own. Whatever the mic heard meanwhile is its own echo, unless
  // you're already talking. Skip it in place (you may answer at once), and start a clean
  // recogniser session once you've stayed quiet for a moment.
  afterSpeech() {
    if (!this.active) return;
    const text = this.ears.text;
    if (text && this.newWords(text) >= BARGE_IN_WORDS) return;
    this.ears.mark();
    this.clearDraft(false);
    this.cleanAt = now() + 1500;
    this.set(this.busy() ? 'thinking' : 'listening');
  }

  newWords(text) {
    const mine = new Set(words(this.mouth.recent));
    return words(text).filter((w) => !mine.has(w)).length;
  }

  isEcho(text) {
    if (now() - this.mouth.endedAt > ECHO_GRACE_MS) return false;
    const w = words(text);
    if (!w.length) return false;
    const mine = new Set(words(this.mouth.recent));
    return w.filter((x) => mine.has(x)).length / w.length >= 0.6;
  }

  // A draft that began while the voice talked starts with its echo: drop those words.
  stripEcho(text) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (!t || !this.echoInDraft) return t;
    const mine = new Set(words(this.mouth.recent));
    const parts = t.split(' ');
    let i = 0;
    while (i < parts.length && mine.has(words(parts[i])[0] || '')) i++;
    return parts.slice(i).join(' ');
  }

  // Tell the server which voices this device has (data/client.log), so Claude can advise.
  reportVoices() {
    const list = rankVoices().map((x) => `${x.name} [${x.voice.lang}]`);
    const picked = this.mouth.pick();
    api.post('/api/clientlog', { kind: 'voices', msg: `picked: ${picked ? picked.name : 'none'} | ${list.length} English: ${list.join(', ')}` })
      .catch(() => {});
  }

  // ---- UI state
  set(state) {
    this.state = state;
    this.emit();
  }

  emit() {
    let caption = '';
    if (this.state === 'speaking') caption = this.mouth.current;
    else if (this.state === 'hearing' || this.state === 'listening') caption = this.stripEcho(this.ears.text);
    else if (this.turn && this.turn.kind === 'utterance') caption = this.lastHeard;
    this.dispatchEvent(new CustomEvent('state', {
      detail: {
        state: this.state,
        caption,
        working: this.working ? { task: this.working.task, secs: Math.floor((Date.now() - this.working.since) / 1000) } : null,
      },
    }));
  }
}
