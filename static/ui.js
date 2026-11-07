// Small UI primitives: toasts/HUD, confirm sheet, lightbox, popovers.
import { icon } from './icons.js';
import { $ } from './util.js';

let hudTimer = 0;
export function hud(text, iconName = '') {
  const el = $('#hud');
  el.innerHTML = (iconName ? icon(iconName) : '') + `<span></span>`;
  el.querySelector('span').textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => el.classList.remove('show'), 900);
}

export function toast(text, { action = '', onAction = null, ms = 3200, tone = '' } = {}) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast glass${tone ? ' ' + tone : ''}`;
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action;
    b.addEventListener('click', () => {
      close();
      onAction && onAction();
    });
    el.appendChild(b);
  }
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 260);
  }
  const t = setTimeout(close, ms);
  el.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('button')) {
      clearTimeout(t);
      close();
    }
  });
  while (host.children.length > 3) host.firstElementChild.remove();
  return close;
}

export function confirmSheet({ title, message = '', confirm = 'OK', cancel = 'Cancel', destructive = false }) {
  const modal = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalMsg').textContent = message;
  const ok = $('#modalOk');
  const no = $('#modalCancel');
  ok.textContent = confirm;
  no.textContent = cancel;
  ok.classList.toggle('danger', destructive);
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
  return new Promise((resolve) => {
    const done = (v) => {
      modal.classList.remove('show');
      setTimeout(() => { modal.hidden = true; }, 220);
      ok.removeEventListener('click', yes);
      no.removeEventListener('click', nope);
      modal.removeEventListener('pointerdown', back);
      document.removeEventListener('keydown', key);
      resolve(v);
    };
    const yes = () => done(true);
    const nope = () => done(false);
    const back = (e) => { if (e.target === modal) done(false); };
    const key = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    ok.addEventListener('click', yes);
    no.addEventListener('click', nope);
    modal.addEventListener('pointerdown', back);
    document.addEventListener('keydown', key);
  });
}

export function lightbox(src) {
  const lb = $('#lightbox');
  const img = lb.querySelector('img');
  img.src = src;
  lb.hidden = false;
  requestAnimationFrame(() => lb.classList.add('show'));
  const close = () => {
    lb.classList.remove('show');
    setTimeout(() => { lb.hidden = true; img.removeAttribute('src'); }, 220);
    lb.removeEventListener('click', close);
  };
  lb.addEventListener('click', close);
}

// Toggleable popover anchored to a button; closes on outside press / Escape.
export function popover(pop, anchor, { onOpen } = {}) {
  const open = () => {
    pop.hidden = false;
    anchor.classList.add('active');
    anchor.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => pop.classList.add('show'));
    onOpen && onOpen();
  };
  const close = () => {
    if (pop.hidden) return;
    pop.classList.remove('show');
    anchor.classList.remove('active');
    anchor.setAttribute('aria-expanded', 'false');
    setTimeout(() => { if (!pop.classList.contains('show')) pop.hidden = true; }, 200);
  };
  anchor.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop.hidden || !pop.classList.contains('show')) open();
    else close();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !anchor.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return { open, close, get isOpen() { return !pop.hidden; } };
}
