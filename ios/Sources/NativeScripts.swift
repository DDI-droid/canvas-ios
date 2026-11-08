/// JavaScript injected at document start (main frame only).
///
/// 1. `window.__canvasNative` tells the page it runs inside the app (the page hides its
///    full-screen button, adds "Server link…" to the ☰ menu and listens for the Pencil).
/// 2. A Web Speech recognition shim (`SpeechRecognition` / `webkitSpeechRecognition`) backed
///    by SpeechBridge: the page's voice code runs unchanged on Apple's native recogniser.
///    Native sends the cumulative transcript; the shim turns each "pause" into a final result.
/// 3. A `speechSynthesis` / `SpeechSynthesisUtterance` shim backed by SpeechSynth, so the
///    page can use every installed voice, including Premium ones (Safari hides those).
enum NativeScripts {
    static func bootstrap(voicesJSON: String) -> String {
        return script.replacingOccurrences(of: "__CANVAS_VOICES__", with: voicesJSON)
    }

    private static let script = #"""
(function () {
  if (window.__canvasNative) return;
  var handlers = window.webkit && window.webkit.messageHandlers;
  if (!handlers || !handlers.canvasSpeech || !handlers.canvasNative || !handlers.canvasSynth) return;

  window.__canvasNative = {
    platform: 'ios',
    version: '1.4',
    post: function (cmd, extra) {
      var msg = { cmd: cmd };
      if (extra) for (var k in extra) msg[k] = extra[k];
      try { handlers.canvasNative.postMessage(msg); } catch (e) {}
    }
  };

  function fire(target, type, props) {
    var ev = new Event(type);
    if (props) for (var k in props) {
      try { Object.defineProperty(ev, k, { value: props[k], enumerable: true }); } catch (e) {}
    }
    var h = target['on' + type];
    if (typeof h === 'function') {
      try { h.call(target, ev); } catch (e) { setTimeout(function () { throw e; }); }
    }
    target.dispatchEvent(ev);
  }

  // ------------------------------------------------------------- speech recognition
  var live = new Map();
  var nextId = 1;
  function list(arr) { var l = arr.slice(); l.item = function (i) { return l[i]; }; return l; }
  function makeResult() {
    var r = [{ transcript: '', confidence: 0.9 }];
    r.isFinal = false;
    r.item = function (i) { return r[i]; };
    return r;
  }

  class NativeSpeechRecognition extends EventTarget {
    constructor() {
      super();
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
      this.grammars = null;
      this.onstart = this.onend = this.onresult = this.onerror = this.onnomatch = null;
      this.onaudiostart = this.onaudioend = this.onsoundstart = this.onsoundend = null;
      this.onspeechstart = this.onspeechend = null;
      this._id = 0;
      this._open = false;
      this._results = [];
      this._prefix = '';
      this._full = '';
    }
    start() {
      if (this._open) throw new DOMException('recognition has already started', 'InvalidStateError');
      this._open = true;
      this._id = nextId++;
      this._results = [];
      this._prefix = '';
      this._full = '';
      live.set(this._id, this);
      handlers.canvasSpeech.postMessage({
        op: 'start', id: this._id,
        lang: this.lang || document.documentElement.lang || 'en-US',
        interim: !!this.interimResults
      });
    }
    stop() { if (this._open) handlers.canvasSpeech.postMessage({ op: 'stop', id: this._id }); }
    abort() { if (this._open) handlers.canvasSpeech.postMessage({ op: 'abort', id: this._id }); }

    // words of the cumulative transcript that are not yet part of a final result
    _tail(full) {
      var p = this._prefix.trim();
      var f = full.trim();
      if (!p) return f;
      if (f.toLowerCase().indexOf(p.toLowerCase()) === 0) return f.slice(p.length).trim();
      var n = p.split(/\s+/).length;
      return f.split(/\s+/).slice(n).join(' ');
    }
    _update(full, isFinal) {
      this._full = full;
      var tail = this._tail(full);
      var idx = this._results.length - 1;
      var cur = this._results[idx];
      if (!cur || cur.isFinal) {
        if (!tail) return;
        cur = makeResult();
        this._results.push(cur);
        idx += 1;
      }
      cur[0].transcript = tail;
      cur.isFinal = !!isFinal;
      if (isFinal) this._prefix = full;
      fire(this, 'result', { resultIndex: idx, results: list(this._results) });
    }
    _finalize() {
      var idx = this._results.length - 1;
      var cur = this._results[idx];
      if (!cur || cur.isFinal) return;
      if (!cur[0].transcript) { this._results.pop(); return; }
      cur.isFinal = true;
      this._prefix = this._full;
      fire(this, 'result', { resultIndex: idx, results: list(this._results) });
    }
    _native(m) {
      switch (m.type) {
        case 'start': fire(this, 'start'); fire(this, 'audiostart'); break;
        case 'partial': this._update(m.text || '', false); break;
        case 'pause': this._finalize(); break;
        case 'final': this._update(m.text || '', true); break;
        case 'error': fire(this, 'error', { error: m.error, message: m.message || '' }); break;
        case 'end':
          this._finalize();
          this._open = false;
          live.delete(this._id);
          fire(this, 'audioend');
          fire(this, 'end');
          break;
      }
    }
  }

  function define(name, value) {
    try { Object.defineProperty(window, name, { value: value, configurable: true, writable: true }); }
    catch (e) { window[name] = value; }
  }
  define('SpeechRecognition', NativeSpeechRecognition);
  define('webkitSpeechRecognition', NativeSpeechRecognition);
  window.__canvasSpeech = {
    emit: function (id, m) { var r = live.get(id); if (r) r._native(m); }
  };

  // ---------------------------------------------------------------- speech synthesis
  var VOICES = (__CANVAS_VOICES__).map(function (v) {
    return { name: v.name, lang: v.lang, voiceURI: v.voiceURI, localService: true, default: !!v.default };
  });

  class NativeSpeechSynthesisUtterance extends EventTarget {
    constructor(text) {
      super();
      this.text = text == null ? '' : String(text);
      this.lang = '';
      this.voice = null;
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.onstart = this.onend = this.onerror = this.onpause = this.onresume = null;
      this.onboundary = this.onmark = null;
    }
  }

  var queue = new Map();   // id -> utterance, until it ends
  var nextUtt = 1;
  var paused = false;
  var synth = new EventTarget();
  synth.onvoiceschanged = null;
  synth.getVoices = function () { return VOICES.slice(); };
  synth.speak = function (u) {
    if (!u) return;
    var id = nextUtt++;
    queue.set(id, u);
    handlers.canvasSynth.postMessage({
      op: 'speak', id: id, text: String(u.text || ''),
      voice: (u.voice && u.voice.voiceURI) || '', lang: u.lang || '',
      rate: +u.rate || 1, pitch: +u.pitch || 1, volume: u.volume == null ? 1 : +u.volume
    });
  };
  synth.cancel = function () {
    var pending = Array.from(queue.values());
    queue.clear();
    handlers.canvasSynth.postMessage({ op: 'cancel' });
    pending.forEach(function (u) { fire(u, 'error', { utterance: u, error: 'interrupted', charIndex: 0, elapsedTime: 0 }); });
  };
  synth.pause = function () { paused = true; handlers.canvasSynth.postMessage({ op: 'pause' }); };
  synth.resume = function () { paused = false; handlers.canvasSynth.postMessage({ op: 'resume' }); };
  Object.defineProperty(synth, 'speaking', { get: function () { return queue.size > 0; } });
  Object.defineProperty(synth, 'pending', { get: function () { return queue.size > 1; } });
  Object.defineProperty(synth, 'paused', { get: function () { return paused; } });

  window.__canvasSynth = {
    emit: function (id, type) {
      var u = queue.get(id);
      if (!u) return;
      if (type === 'start') { fire(u, 'start', { utterance: u, charIndex: 0, elapsedTime: 0 }); return; }
      queue.delete(id);
      fire(u, 'end', { utterance: u, charIndex: 0, elapsedTime: 0 });
    }
  };
  define('SpeechSynthesisUtterance', NativeSpeechSynthesisUtterance);
  define('speechSynthesis', synth);
  setTimeout(function () { fire(synth, 'voiceschanged'); }, 0);
})();
"""#
}
