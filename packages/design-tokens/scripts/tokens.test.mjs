import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { contrast, contrastReport, cssName, declarations, flatten, loadTokens } from './tokens.mjs';

const flat = loadTokens(
  fileURLToPath(new URL('../../../docs/02-design/tokens.json', import.meta.url)),
);

test('every contrast pair in tokens.json meets WCAG AA', () => {
  assert.deepEqual(
    contrastReport(flat).filter((r) => !r.ok),
    [],
  );
});

test('contrast maths matches known values', () => {
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(1), '21.0');
  assert.equal(contrast('#777777', '#777777'), 1);
});

test('widget tokens use the --kaki- namespace and resolve references', () => {
  const { widget, core } = declarations(flat, 'light');
  assert.ok(widget.every(([n]) => n.startsWith('--kaki-')));
  assert.ok(core.every(([n]) => !n.startsWith('--kaki-')));
  const accent = Object.fromEntries(widget)['--kaki-accent'];
  assert.equal(accent, Object.fromEntries(core)['--color-accent-default']);
  assert.equal(cssName('color.bg.canvas'), '--color-bg-canvas');
});

test('unresolved references fail loudly', () => {
  const broken = flatten({ a: { $type: 'color', $value: '{nope}' } });
  assert.throws(() => declarations(broken, 'light'), /Unresolved/);
});

test('agrees with the design phase generator output (anchors/tokens.css)', async () => {
  const { readFileSync } = await import('node:fs');
  const anchor = readFileSync(
    fileURLToPath(new URL('../../../docs/02-design/anchors/tokens.css', import.meta.url)),
    'utf8',
  );
  const rootBlock = anchor.slice(anchor.indexOf(':root {'), anchor.indexOf('}'));
  for (const [n, v] of declarations(flat, 'light').core) {
    assert.ok(rootBlock.includes(`${n}: ${v};`), `${n} differs from anchors/tokens.css`);
  }
});
