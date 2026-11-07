// Curated ink palette. Strokes store the key; colour resolves per theme at render time
// (snapshots for Claude always use the light values on paper).

export const COLORS = [
  { key: 'ink', name: 'black', light: '#1c1c1e', dark: '#f2f2f4', hl: '#a1a1aa' },
  { key: 'blue', name: 'blue', light: '#1d5fd9', dark: '#62a3ff', hl: '#5aa9ff' },
  { key: 'red', name: 'red', light: '#d8382d', dark: '#ff6d60', hl: '#ff7a7a' },
  { key: 'green', name: 'green', light: '#178a4a', dark: '#4fd383', hl: '#59d68a' },
  { key: 'orange', name: 'orange', light: '#e3700b', dark: '#ffa04a', hl: '#ffab4c' },
  { key: 'purple', name: 'purple', light: '#7446d4', dark: '#b590ff', hl: '#b48cff' },
  { key: 'teal', name: 'teal', light: '#0b8c97', dark: '#45d0db', hl: '#4fd8e2' },
  { key: 'yellow', name: 'yellow', light: '#e8b500', dark: '#ffd84a', hl: '#ffd60a' },
];

const MAP = Object.fromEntries(COLORS.map((c) => [c.key, c]));

export const HL_ALPHA = { light: 0.42, dark: 0.68 };

export function inkColor(key, theme = 'light', highlighter = false) {
  const c = MAP[key] || MAP.ink;
  if (highlighter) return c.hl;
  return theme === 'dark' ? c.dark : c.light;
}

export function colorName(key) {
  return (MAP[key] || MAP.ink).name;
}

export const PAPER = { light: '#f8f6f1', dark: '#1a1a1c' };
