// Markdown (marked) + math (KaTeX) -> sanitized HTML (DOMPurify).
import { Marked } from './vendor/marked/marked.esm.js';
import DOMPurify from './vendor/dompurify/purify.es.mjs';
import katex from './vendor/katex/katex.mjs';

const purifier = DOMPurify(window);
purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function tex(src, displayMode) {
  try {
    return katex.renderToString(src, { displayMode, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
  } catch {
    const esc = src.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return `<code class="math-error">${esc}</code>`;
  }
}

const blockMath = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    const m = src.match(/\$\$|\\\[/);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src) || /^\\\[([\s\S]+?)\\\][^\S\n]*(?:\n|$)/.exec(src);
    if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer(token) {
    return `<div class="math-block">${tex(token.text, true)}</div>\n`;
  },
};

const inlineMath = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const m = src.match(/\$|\\\(/);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    let m = /^\$\$([\s\S]+?)\$\$/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true };
    m = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: false };
    m = /^\$((?:\\.|[^\\\n$])+?)\$/.exec(src);
    if (m) {
      const body = m[1];
      const after = src.charAt(m[0].length);
      // pandoc rule: no whitespace just inside the delimiters, no digit right after ("$5 and $6")
      if (/^\s|\s$/.test(body) || /\d/.test(after)) return undefined;
      return { type: 'inlineMath', raw: m[0], text: body, display: false };
    }
    return undefined;
  },
  renderer(token) {
    return tex(token.text, token.display);
  },
};

const marked = new Marked({ gfm: true, breaks: true });
marked.use({ extensions: [blockMath, inlineMath] });

// Tables in a narrow chat: each cell remembers its column's heading (data-label), so app.css can
// show a row as a small card ("Heading: value" lines) when the chat is too narrow for columns.
// The table also gets a wrapper that scrolls sideways when it's wide but doesn't fit.
function prepareTables(html) {
  if (!html.includes('<table')) return html;
  const t = document.createElement('template');
  t.innerHTML = html;
  for (const table of t.content.querySelectorAll('table')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const tr of table.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => { if (heads[i]) td.setAttribute('data-label', heads[i]); });
    }
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
  return t.innerHTML;
}

export function renderMarkdown(md) {
  let html;
  try {
    html = marked.parse(String(md ?? ''));
  } catch {
    html = String(md ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  html = purifier.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'] });
  try {
    return prepareTables(html); // only rearranges what DOMPurify already let through
  } catch {
    return html;
  }
}
