// Loaded first, as a classic script: catches errors that would leave the canvas blank,
// shows them on screen, and sends them to the server (data/client.log) so Claude can read them.
(function () {
  // The theme before the first paint: the page starts as light, so in dark mode it would flash
  // light until app.js runs. (Same choice as app.js initialTheme: the saved one, else the system's.)
  try {
    var raw = localStorage.getItem('canvas.prefs') || ((window.__canvasNativeStore || {}).prefs);
    var theme = (raw && JSON.parse(raw).theme) ||
      (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', theme === 'dark' ? '#1a1a1c' : '#f8f6f1');
  } catch (e) { /* app.js sets it */ }

  var meta = document.querySelector('meta[name="canvas-key"]');
  var key = meta ? meta.getAttribute('content') : '';
  var errs = [];
  var sent = 0;

  function show() {
    var el = document.getElementById('bootError');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bootError';
      el.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:99999;padding:12px 14px;' +
        'border-radius:14px;background:#ff3b30;color:#fff;font:13px/1.45 -apple-system,system-ui,sans-serif;' +
        'white-space:pre-wrap;word-break:break-word;box-shadow:0 8px 30px rgba(0,0,0,.25)';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = 'Canvas hit an error (Claude can see it):\n' + errs.slice(-3).join('\n');
  }

  function report(kind, msg, src, line, col, stack) {
    var where = src ? ' @ ' + String(src).split('?')[0].split('/').pop() + ':' + (line || 0) + ':' + (col || 0) : '';
    errs.push(kind + ': ' + msg + where);
    if (sent++ < 20) {
      try {
        fetch('/api/clientlog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Canvas-Key': key },
          body: JSON.stringify({ kind: kind, msg: String(msg), src: String(src || '').split('?')[0], line: line || 0,
            col: col || 0, stack: String(stack || '').slice(0, 3000), ua: navigator.userAgent }),
        }).catch(function () { /* offline: nothing to do */ });
      } catch (e) { /* ignore */ }
    }
    // On screen only while starting up, or for real script errors; a dropped request after
    // boot (Safari: "Load failed") is reported quietly.
    var app = document.getElementById('app');
    var booting = !app || /\bbooting\b/.test(app.className);
    if (!booting && kind !== 'error') return;
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show);
  }

  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      report('load', 'failed to load ' + (t.src || t.href).split('?')[0].split('/').pop(), '', 0, 0, '');
      return;
    }
    report('error', e.message, e.filename, e.lineno, e.colno, e.error && e.error.stack);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    report('rejection', r.message || String(r), '', 0, 0, r.stack);
  });
  // The UI shows within a moment of the code loading (the board's data follows in the
  // background), so still hidden after 10 s means the code itself didn't load or run.
  setTimeout(function () {
    var app = document.getElementById('app');
    if (app && /\bbooting\b/.test(app.className)) report('boot', 'still starting after 10 s', '', 0, 0, '');
  }, 10000);
  // app.js calls this once it's up: a slow start that recovered by itself isn't an error any more.
  window.__canvasBooted = function () {
    var left = errs.filter(function (e) { return e.indexOf('boot: ') !== 0; });
    if (left.length === errs.length) return;
    errs = left;
    var el = document.getElementById('bootError');
    if (!el) return;
    if (errs.length) show();
    else el.remove();
  };
})();
