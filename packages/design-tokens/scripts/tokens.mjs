// Port of docs/02-design/tools/gen_tokens_css.py (the design phase's generator) so the
// app build consumes tokens.json directly. Same resolution, naming and contrast pairs.
import { readFileSync } from 'node:fs';

export const MODE = 'org.kakiagent.modes';

export function flatten(tokens) {
  const flat = {};
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      if (v && typeof v === 'object' && '$value' in v) flat[[...path, k].join('.')] = v;
      else if (v && typeof v === 'object') walk(v, [...path, k]);
    }
  };
  walk(tokens, []);
  return flat;
}

export function valueOf(flat, token, mode) {
  const raw =
    mode === 'dark' && token.$extensions?.[MODE] ? token.$extensions[MODE].dark : token.$value;
  if (typeof raw === 'string') {
    const m = /^\{(.+)\}$/.exec(raw);
    if (m) {
      const ref = flat[m[1]];
      if (!ref) throw new Error(`Unresolved token reference ${raw}`);
      return valueOf(flat, ref, mode);
    }
  }
  return raw;
}

export function cssValue(token, v) {
  switch (token.$type) {
    case 'fontFamily':
      return v.map((f) => (f.includes(' ') ? `"${f}"` : f)).join(', ');
    case 'shadow':
      return `${v.offsetX} ${v.offsetY} ${v.blur} ${v.spread} ${v.color}`;
    case 'cubicBezier':
      return `cubic-bezier(${v.join(', ')})`;
    default:
      return String(v);
  }
}

export function cssName(path) {
  const p = path.split('.');
  return p[0] === 'widget' ? `--kaki-${p.slice(1).join('-')}` : `--${p.join('-')}`;
}

/** Declarations for one mode, split into core (`--*`) and widget (`--kaki-*`). */
export function declarations(flat, mode) {
  const core = [];
  const widget = [];
  for (const [path, token] of Object.entries(flat)) {
    const target = path.startsWith('widget.') ? widget : core;
    if (token.$type === 'typography') {
      const v = valueOf(flat, token, mode);
      const n = cssName(path);
      target.push(
        [`${n}-size`, v.fontSize],
        [`${n}-line`, String(v.lineHeight)],
        [`${n}-weight`, String(v.fontWeight)],
      );
      continue;
    }
    target.push([cssName(path), cssValue(token, valueOf(flat, token, mode))]);
  }
  return { core, widget };
}

function luminance(hex) {
  const h = hex.replace('#', '').slice(0, 6);
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const PAIRS = [
  ['color.text.primary', 'color.bg.canvas', 4.5],
  ['color.text.primary', 'color.bg.surface', 4.5],
  ['color.text.secondary', 'color.bg.surface', 4.5],
  ['color.text.secondary', 'color.bg.canvas', 4.5],
  ['color.text.secondary', 'color.bg.subtle', 4.5],
  ['color.text.on-accent', 'color.accent.default', 4.5],
  ['color.text.on-accent', 'color.accent.hover', 4.5],
  ['color.accent.default', 'color.bg.surface', 4.5],
  ['color.accent.default', 'color.bg.canvas', 4.5],
  ['color.accent.default', 'color.accent.soft', 4.5],
  ['color.border.strong', 'color.bg.surface', 3.0],
  ['color.focus', 'color.bg.surface', 3.0],
  ['color.focus', 'color.bg.canvas', 3.0],
  ...['success', 'warning', 'danger', 'info', 'pending'].flatMap((s) => [
    [`color.${s}.default`, `color.${s}.soft`, 4.5],
    [`color.${s}.default`, 'color.bg.surface', 4.5],
  ]),
  ['color.text.on-accent', 'color.danger.default', 4.5],
];

export function contrastReport(flat) {
  const rows = [];
  for (const mode of ['light', 'dark']) {
    for (const [fg, bg, min] of PAIRS) {
      const ratio = contrast(valueOf(flat, flat[fg], mode), valueOf(flat, flat[bg], mode));
      rows.push({ mode, fg, bg, min, ratio, ok: ratio >= min });
    }
  }
  return rows;
}

export function loadTokens(path) {
  return flatten(JSON.parse(readFileSync(path, 'utf8')));
}
