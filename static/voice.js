// Web Speech API wrapper tuned for iOS Safari: continuous + interim results, auto-restart
// while the mic is toggled on, de-duplication of cumulative/duplicate finals, and timed
// segments for the timeline.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const voiceSupported = !!SR;

export class Voice extends EventTarget {
  constructor(lang = 'en-US') {
    super();
    this.lang = lang;
    this.on = false;
    this.session = null;
    this.segments = []; // {start, end, text} epoch ms, since last take()
    this.interim = '';
    this.quickFails = 0;
    this.restartTimer = 0;
    this.state = 'off'; // off | starting | listening | error
  }

  get supported() {
    return voiceSupported;
  }

  setLang(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    if (this.on && this.session) this._recycle();
  }

  toggle() {
    if (this.on) this.stop();
    else this.start();
  }

  start() {
    if (!SR) {
      this._setState('error', 'Speech recognition is not available in this browser — type or use keyboard dictation.');
      return false;
    }
    this.on = true;
    this.quickFails = 0;
    this._spawn();
    return true;
  }

  stop() {
    this.on = false;
    clearTimeout(this.restartTimer);
    const s = this.session;
    this.session = null;
    if (s) {
      s.dead = true;
      this._flushInterim(s);
      try { s.rec.stop(); } catch { /* ignore */ }
    }
    this._setInterim('');
    this._setState('off');
  }

  // Take everything recognised so far for a message being sent: commits pending interim
  // text and starts a fresh recognition session so nothing is counted twice.
  take() {
    const s = this.session;
    if (s && this.interim.trim()) {
      // only restart the recogniser when words are mid-flight (restarts are disruptive on iOS)
      this._flushInterim(s);
      if (this.on) this._recycle();
    }
    const segs = this.segments;
    this.segments = [];
    return segs;
  }

  discardSegments() {
    this.segments = [];
    const pending = !!this.interim.trim();
    this._setInterim('');
    if (this.session) {
      this.session.lastFinal = '';
      if (this.on && pending) this._recycle();
    }
  }

  _recycle() {
    const s = this.session;
    this.session = null;
    if (s) {
      s.dead = true;
      try { s.rec.abort(); } catch { /* ignore */ }
    }
    this._setInterim('');
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (this.on && !this.session) this._spawn();
    }, 220);
  }

  _spawn() {
    clearTimeout(this.restartTimer);
    let rec;
    try {
      rec = new SR();
    } catch (err) {
      this.on = false;
      this._setState('error', 'Could not start speech recognition.');
      return;
    }
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const s = { rec, dead: false, finals: new Set(), starts: new Map(), lastFinal: '', interimStart: 0, startedAt: Date.now(), gotResult: false };
    this.session = s;
    if (this.state !== 'listening') this._setState('starting');

    rec.onstart = () => {
      if (s.dead) return;
      this._setState('listening');
    };
    rec.onaudiostart = rec.onsoundstart = rec.onspeechstart = () => {
      if (!s.dead) this._level(0.6);
    };
    rec.onresult = (e) => {
      if (s.dead) return;
      s.gotResult = true;
      this.quickFails = 0;
      const now = Date.now();
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = (r[0] && r[0].transcript) || '';
        if (!s.starts.has(i)) s.starts.set(i, now);
        if (r.isFinal) {
          if (!s.finals.has(i)) {
            s.finals.add(i);
            this._commit(s, text, s.starts.get(i), now);
          }
        } else {
          interim += text;
        }
      }
      interim = this._stripPrefix(s, interim.trim());
      if (interim && !s.interimStart) s.interimStart = now;
      if (!interim) s.interimStart = 0;
      this._setInterim(interim);
      this._level(1);
    };
    rec.onerror = (e) => {
      if (s.dead) return;
      const err = e.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        this.on = false;
        s.dead = true;
        this.session = null;
        this._setInterim('');
        this._setState('error', 'Microphone or speech permission was denied. Enable it in Settings › Safari, and make sure Siri & Dictation is on.');
      } else if (err === 'audio-capture') {
        this._setState('error', 'No microphone available.');
      } else if (err === 'language-not-supported') {
        this.on = false;
        this._setState('error', `Speech language ${this.lang} is not supported here.`);
      }
      // 'no-speech', 'aborted', 'network': let onend restart us
    };
    rec.onend = () => {
      if (s.dead) return;
      this._flushInterim(s);
      this.session = null;
      this._setInterim('');
      if (!this.on) {
        this._setState('off');
        return;
      }
      const short = Date.now() - s.startedAt < 1500 && !s.gotResult;
      this.quickFails = short ? this.quickFails + 1 : 0;
      if (this.quickFails >= 6) {
        this.on = false;
        this._setState('error', 'Speech recognition keeps stopping. Tap the mic to try again.');
        return;
      }
      const delay = short ? Math.min(2000, 250 * 2 ** this.quickFails) : 120;
      this.restartTimer = setTimeout(() => {
        if (this.on && !this.session) this._spawn();
      }, delay);
    };
    try {
      rec.start();
    } catch (err) {
      // "already started" or not allowed outside a gesture: retry shortly, then give up
      this.session = null;
      s.dead = true;
      this.quickFails++;
      if (this.quickFails >= 6) {
        this.on = false;
        this._setState('error', 'Tap the mic to resume listening.');
        return;
      }
      this.restartTimer = setTimeout(() => {
        if (this.on && !this.session) this._spawn();
      }, 400);
    }
  }

  // iOS sometimes returns cumulative transcripts within a session; keep only the new tail.
  _stripPrefix(s, text) {
    const prev = s.lastFinal;
    if (prev && text.toLowerCase().startsWith(prev.toLowerCase())) return text.slice(prev.length).trim();
    return text;
  }

  _commit(s, raw, start, end) {
    const full = raw.trim();
    if (!full) return;
    const prev = s.lastFinal;
    if (prev && (full.toLowerCase() === prev.toLowerCase() || prev.toLowerCase().endsWith(full.toLowerCase()))) return;
    const text = this._stripPrefix(s, full);
    s.lastFinal = full;
    s.interimStart = 0;
    if (!text) return;
    const seg = { start: start || end, end, text };
    this.segments.push(seg);
    this.dispatchEvent(new CustomEvent('final', { detail: seg }));
  }

  _flushInterim(s) {
    const text = this.interim.trim();
    if (!text) return;
    const now = Date.now();
    this._commit(s, text, s.interimStart || now, now);
    this._setInterim('');
  }

  _setInterim(text) {
    if (text === this.interim) return;
    this.interim = text;
    this.dispatchEvent(new CustomEvent('interim', { detail: text }));
  }

  _level(v) {
    this.dispatchEvent(new CustomEvent('level', { detail: v }));
  }

  _setState(state, message = '') {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, message } }));
  }
}
