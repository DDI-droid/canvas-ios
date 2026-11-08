// Hand-drawn inline SVG icons on a 24px grid (stroke-based, currentColor).

const P = {
  pen:
    '<path d="M15.2 4.3a2.3 2.3 0 0 1 3.25 0l1.25 1.25a2.3 2.3 0 0 1 0 3.25L9.1 19.4l-4.6 1.1 1.1-4.6z"/>' +
    '<path d="M13.6 5.9l4.5 4.5"/>',
  highlighter:
    '<path d="M4 21h7" stroke-width="2.6" opacity=".38"/>' +
    '<path d="M9.4 15.9 7.5 14l7.9-9.3a2 2 0 0 1 2.9-.1l1.1 1.1a2 2 0 0 1-.1 2.9z"/>' +
    '<path d="M7.5 14 5.4 16.1a1 1 0 0 0 0 1.4l1.1 1.1a1 1 0 0 0 1.4 0l1.5-1.5"/>',
  eraser:
    '<path d="M10 20.5h10"/>' +
    '<path d="M5 14.3 13.6 5.7a2 2 0 0 1 2.8 0l3 3a2 2 0 0 1 0 2.8L11 20H8.4L5 16.6a1.6 1.6 0 0 1 0-2.3z"/>' +
    '<path d="M9.3 10.1l5.6 5.6"/>',
  lasso:
    '<path d="M6.7 15.2C4.4 14.1 3 12.4 3 10.5 3 7 7 4.2 12 4.2s9 2.8 9 6.3-4 6.3-9 6.3c-.9 0-1.8-.1-2.6-.3" stroke-dasharray="2.4 2.6"/>' +
    '<circle cx="7.8" cy="16.4" r="1.6"/>' +
    '<path d="M7.4 18c-.4 1.3.2 2.3 1.4 2.8"/>',
  undo: '<path d="M8.5 13.5 4 9l4.5-4.5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H12"/>',
  redo: '<path d="M15.5 13.5 20 9l-4.5-4.5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H12"/>',
  mic:
    '<rect x="8.75" y="2.75" width="6.5" height="11.5" rx="3.25"/>' +
    '<path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5v3.75"/>',
  micOff:
    '<path d="M15.25 10.2V6a3.25 3.25 0 0 0-6.2-1.36"/><path d="M8.75 9.5V11a3.25 3.25 0 0 0 5.3 2.5"/>' +
    '<path d="M18.5 11a6.47 6.47 0 0 1-.7 2.9M5.5 11a6.5 6.5 0 0 0 10.4 5.2"/><path d="M12 17.5v3.75"/><path d="M4 4l16 16"/>',
  send: '<path d="M12 19.25V5.5"/><path d="M6 11.25 12 5.25l6 6"/>',
  sliders:
    '<path d="M4 7.5h8.5M18 7.5h2M4 16.5h2M11.5 16.5H20"/>' +
    '<circle cx="15.25" cy="7.5" r="2.25"/><circle cx="8.75" cy="16.5" r="2.25"/>',
  sparkle:
    '<path d="M12 3.6c.55 4.35 2.05 5.85 6.4 6.4-4.35.55-5.85 2.05-6.4 6.4-.55-4.35-2.05-5.85-6.4-6.4 4.35-.55 5.85-2.05 6.4-6.4z"/>' +
    '<path d="M18.6 15.6c.2 1.5.7 2 2.2 2.2-1.5.2-2 .7-2.2 2.2-.2-1.5-.7-2-2.2-2.2 1.5-.2 2-.7 2.2-2.2z"/>',
  sparkleOff:
    '<path d="M12 3.6c.55 4.35 2.05 5.85 6.4 6.4-4.35.55-5.85 2.05-6.4 6.4-.55-4.35-2.05-5.85-6.4-6.4 4.35-.55 5.85-2.05 6.4-6.4z"/>' +
    '<path d="M4 4l16 16"/>',
  ghost:
    '<path d="M6 20.25V10.5a6 6 0 0 1 12 0v9.75l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z"/>' +
    '<path d="M9.75 10.25v.5M14.25 10.25v.5" stroke-width="2.2"/>',
  opacity:
    '<circle cx="12" cy="12" r="8.25"/>' +
    '<path d="M12 3.75a8.25 8.25 0 0 1 0 16.5z" fill="currentColor" stroke="none" opacity=".9"/>',
  widths:
    '<rect x="3.75" y="4.75" width="16.5" height="14.5" rx="3"/><path d="M7.5 12h9"/><path d="M9.6 9.6 7.2 12l2.4 2.4M14.4 9.6l2.4 2.4-2.4 2.4"/>',
  minimize: '<path d="M14 4.5v5.5h5.5"/><path d="M20 4l-6 6"/><path d="M10 19.5V14H4.5"/><path d="M4 20l6-6"/>',
  dock: '<rect x="3.5" y="4.75" width="17" height="14.5" rx="3"/><path d="M14.25 4.75v14.5"/>',
  trash:
    '<path d="M4.75 6.75h14.5"/><path d="M9.5 6.75V5.2c0-.8.6-1.45 1.4-1.45h2.2c.8 0 1.4.65 1.4 1.45v1.55"/>' +
    '<path d="M6.6 6.75l.75 11.9a1.9 1.9 0 0 0 1.9 1.8h5.5a1.9 1.9 0 0 0 1.9-1.8l.75-11.9"/><path d="M10.1 10.75v5.75M13.9 10.75v5.75"/>',
  duplicate:
    '<rect x="8.75" y="8.75" width="11.5" height="11.5" rx="2.75"/>' +
    '<path d="M15.25 8.75V6.5a2.75 2.75 0 0 0-2.75-2.75h-6A2.75 2.75 0 0 0 3.75 6.5v6a2.75 2.75 0 0 0 2.75 2.75h2.25"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  sun:
    '<circle cx="12" cy="12" r="3.75"/>' +
    '<path d="M12 2.75v1.75M12 19.5v1.75M2.75 12H4.5M19.5 12h1.75M5.46 5.46l1.24 1.24M17.3 17.3l1.24 1.24M5.46 18.54l1.24-1.24M17.3 6.7l1.24-1.24"/>',
  moon: '<path d="M19.6 14.6A8 8 0 0 1 9.4 4.4a8 8 0 1 0 10.2 10.2z"/>',
  fit:
    '<path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15"/>' +
    '<rect x="8.25" y="8.25" width="7.5" height="7.5" rx="1.5"/>',
  arrowDown: '<path d="M12 5v13.5"/><path d="M6.5 13 12 18.5 17.5 13"/>',
  retry: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.75 4.5v4.25H15.5"/>',
  claude:
    '<path d="M12 3.25v5.1M12 15.65v5.1M3.25 12h5.1M15.65 12h5.1M5.8 5.8l3.6 3.6M14.6 14.6l3.6 3.6M5.8 18.2l3.6-3.6M14.6 9.4l3.6-3.6" stroke-width="2.1"/>',
  board:
    '<rect x="3.75" y="4.75" width="16.5" height="14.5" rx="3"/><path d="M7.5 14.5c1.4-3 2.8-4.5 4.2-4.5s1.7 2.6 3 2.6c.9 0 1.6-.8 1.8-1.6"/>',
  view: '<rect x="3.75" y="5.75" width="16.5" height="12.5" rx="3"/><circle cx="12" cy="12" r="2.6"/>',
  check: '<path d="M5.5 12.5l4 4 9-9.5"/>',
  wave: '<path d="M4 12h1.5M7.5 8.5v7M11 5.5v13M14.5 8.5v7M18 10.5v3M20 12h0"/>',
  expand: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
  shrink: '<path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  auto: '<circle cx="12" cy="12" r="7.75"/><path d="M12 4.25a7.75 7.75 0 0 1 0 15.5z" fill="currentColor" stroke="none"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
}

export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.querySelector(':scope > svg.ico')) continue;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  }
}
