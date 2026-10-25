import { widgetTokens } from '@kaki/design-tokens/widget';
import { describe, expect, it } from 'vitest';
import { parsePreviewMessage } from './preview-message.js';
import { hostSheetCss, hostStyle, resolved, tokenSheet } from './theme.js';

const theme = {
  position: 'left' as const,
  overrides: { accent: '#c2410c' },
  detected: null,
  logoUrl: null,
};

describe('host style (FEAT-032 §5.2)', () => {
  it('anchors to the chosen corner, with !important', () => {
    expect(hostStyle('right')).toContain('right:var(--kaki-edge-offset,20px)!important');
    expect(hostStyle('right')).not.toMatch(/(^|;)left:/);
    expect(hostStyle('left')).toContain('left:var(--kaki-edge-offset,20px)!important');
    expect(hostStyle('left')).not.toMatch(/(^|;)right:/);
    for (const p of ['right', 'left'] as const)
      expect(hostStyle(p)).toContain('position:fixed!important');
  });

  it('builds the host sheet from the defaults and the resolved tokens', () => {
    const css = hostSheetCss(
      resolved(theme, { accent: null, font: 'Lora', radius: 6, scheme: 'dark' }),
    );
    expect(css.startsWith(`:host{all:initial;${widgetTokens.dark}`)).toBe(true);
    expect(css).toContain('--kaki-accent:#c2410c');
    expect(css).toContain('--kaki-radius:6px');
    expect(css).toMatch(/--kaki-font:"Lora"/);
  });
});

describe('tokenSheet', () => {
  class FakeSheet {
    css = '';
    replaceSync(css: string) {
      this.css = css;
    }
  }
  it('keeps one sheet first and replaces its text on every swap', () => {
    const other = new FakeSheet();
    const shadow = { adoptedStyleSheets: [other] as FakeSheet[], prepend: () => undefined };
    const t = tokenSheet(shadow, { Sheet: FakeSheet });
    t.set(':host{--kaki-accent:#111111}');
    t.set(':host{--kaki-accent:#222222}');
    expect(shadow.adoptedStyleSheets).toHaveLength(2);
    expect(shadow.adoptedStyleSheets[1]).toBe(other);
    expect(shadow.adoptedStyleSheets[0]!.css).toBe(':host{--kaki-accent:#222222}');
  });

  it('falls back to one <style> without constructable sheets', () => {
    const nodes: { textContent: string | null }[] = [];
    const shadow = { prepend: (n: unknown) => nodes.unshift(n as { textContent: string | null }) };
    const t = tokenSheet(shadow, { createStyle: () => ({ textContent: null }) });
    t.set('a');
    t.set('b');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.textContent).toBe('b');
  });
});

describe('preview messages (§5.3)', () => {
  const ok = { type: 'kaki-preview', theme, botName: 'Kaki', greeting: 'Hi!' };
  it('accepts a well-formed message', () => {
    expect(parsePreviewMessage(ok)).toMatchObject({ botName: 'Kaki', theme: { position: 'left' } });
    expect(
      parsePreviewMessage({ ...ok, scheme: 'dark', site: { background: '#121212', font: 'Lora' } }),
    ).not.toBeNull();
  });
  it('ignores anything else', () => {
    for (const bad of [
      null,
      'kaki-preview',
      { ...ok, type: 'other' },
      { ...ok, theme: { ...theme, position: 'top' } },
      { ...ok, theme: { ...theme, overrides: { radius: 99 } } },
      { ...ok, botName: '' },
      { ...ok, site: { background: 'red;}', font: null } },
      { ...ok, site: { background: null, font: 'x;}' } },
    ])
      expect(parsePreviewMessage(bad)).toBeNull();
  });
});
