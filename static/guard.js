// Loaded first, as a classic script: catches errors that would leave the canvas blank,
// shows them on screen, and sends them to the server (data/client.log) so Claude can read them.
(function () {
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
  setTimeout(function () {
    var app = document.getElementById('app');
    if (app && /\bbooting\b/.test(app.className)) report('boot', 'still starting after 10 s', '', 0, 0, '');
  }, 10000);
})();
