// Runs inside every live page card (a sandboxed iframe with no access to the canvas or its key).
// The canvas talks to it with postMessage:
//  - input: on the board, the iframe never receives touches itself (so the Pencil keeps drawing
//    over it); the canvas forwards the finger here and it's replayed at that spot as pointer and
//    mouse events, a click for a tap, and a scroll for a drag nothing else used.
//  - data: live updates for the card. Pages listen with
//      window.addEventListener('canvas:data', (e) => e.detail.data)  or  window.onCanvasData = (data, mode) => {}
//    The latest data is also in window.__canvasData when the page loads.
//  - visibility: 'canvas:visibility' {visible}: pause animation while the card is off screen.
(function () {
  if (window.__canvasBridge) return;
  window.__canvasBridge = true;
  window.__canvasVisible = true;
  var parent = window.parent;

  // libraries capture pointers (setPointerCapture) on our replayed pointers: keep that harmless
  ['setPointerCapture', 'releasePointerCapture'].forEach(function (k) {
    var orig = Element.prototype[k];
    Element.prototype[k] = function (id) { try { return orig.call(this, id); } catch (e) { /* replayed pointer */ } };
  });

  var down = null;
  function fire(type, x, y, target, buttons) {
    var init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y,
      pointerId: 1, pointerType: 'touch', isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0,
      button: type === 'pointermove' ? -1 : 0, buttons: buttons };
    var pe = new PointerEvent(type, init);
    var free = target.dispatchEvent(pe);
    var mt = { pointerdown: 'mousedown', pointermove: 'mousemove', pointerup: 'mouseup' }[type];
    if (mt) free = target.dispatchEvent(new MouseEvent(mt, init)) && free;
    return free;
  }
  function scrollerAt(el) {
    for (; el && el !== document.documentElement && el !== document.body; el = el.parentElement) {
      var s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY + ' ' + s.overflowX) &&
          (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) return el;
    }
    return document.scrollingElement || document.documentElement;
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.canvas !== 1) return;
    if (m.type === 'input') {
      var x = m.x, y = m.y;
      if (m.kind === 'down') {
        var t = document.elementFromPoint(x, y) || document.body;
        down = { t: t, x: x, y: y, sx: x, sy: y, moved: false, free: fire('pointerdown', x, y, t, 1), scroller: scrollerAt(t) };
      } else if (m.kind === 'move' && down) {
        if (!down.moved && Math.hypot(x - down.sx, y - down.sy) > 6) down.moved = true;
        var free = fire('pointermove', x, y, down.t, 1);
        if (down.moved && down.free && free && down.scroller) down.scroller.scrollBy(down.x - x, down.y - y);
        down.x = x; down.y = y;
      } else if (m.kind === 'up' && down) {
        fire('pointerup', x, y, down.t, 0);
        if (!down.moved) {
          down.t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
          if (typeof down.t.focus === 'function') down.t.focus();
        }
        down = null;
      } else if (m.kind === 'cancel' && down) {
        fire('pointercancel', x, y, down.t, 0);
        down = null;
      }
    } else if (m.type === 'data') {
      if (m.mode !== 'append') window.__canvasData = m.data;
      window.dispatchEvent(new CustomEvent('canvas:data', { detail: { data: m.data, mode: m.mode || 'replace' } }));
      if (typeof window.onCanvasData === 'function') window.onCanvasData(m.data, m.mode || 'replace');
    } else if (m.type === 'visibility') {
      window.__canvasVisible = !!m.visible;
      window.dispatchEvent(new CustomEvent('canvas:visibility', { detail: { visible: !!m.visible } }));
    }
  });
  // outside links (another site, or a new tab) open in this same card as a live browser: the
  // canvas does it (a sandboxed page can't open tabs, and a card is one page at a time)
  function outside(href, target) {
    try {
      var u = new URL(href, location.href);
      return /^https?:$/.test(u.protocol) && (u.origin !== location.origin || (!!target && target !== '_self'));
    } catch (e) { return false; }
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || e.defaultPrevented || !outside(a.href, a.getAttribute('target'))) return;
    e.preventDefault();
    parent.postMessage({ canvas: 1, type: 'link', url: new URL(a.href, location.href).href }, '*');
  }, true);
  var open0 = window.open;
  window.open = function (u) {
    if (u && outside(u, '_blank')) {
      parent.postMessage({ canvas: 1, type: 'link', url: new URL(u, location.href).href }, '*');
      return null;
    }
    return open0.apply(window, arguments);
  };
  window.addEventListener('load', function () { parent.postMessage({ canvas: 1, type: 'ready' }, '*'); });
})();
