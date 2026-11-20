import { EventTimeline, MetaGrid } from '@kaki/ui';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// FEAT-076 T7: the shared detail-page parts render the semantics the design names.
describe('EventTimeline', () => {
  const html = renderToStaticMarkup(
    createElement(EventTimeline, {
      label: 'Steps',
      announce: 'Step 3 of 5: Find facts, in progress',
      steps: [
        { key: 'added', label: 'Added', icon: 'plus', state: 'done', caption: '17 Nov' },
        { key: 'crawl', label: 'Read pages', icon: 'globe', state: 'done', caption: 'Done' },
        {
          key: 'extract',
          label: 'Find facts',
          icon: 'sparkles',
          state: 'current',
          caption: '18 of 38',
        },
        { key: 'promote', label: 'Save facts', icon: 'save', state: 'waiting', caption: 'Waiting' },
      ],
    }),
  );

  it('is an ordered list named by its label, with one step in progress', () => {
    expect(html).toContain('<ol class="kaki-timeline__steps" aria-label="Steps">');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^]*Find facts/);
  });

  it('says nothing in its live region on the first render', () => {
    expect(html).toMatch(/aria-live="polite" data-testid="timeline-announce"><\/span>/);
  });
});

describe('MetaGrid', () => {
  it('renders label/value pairs as a description list', () => {
    const html = renderToStaticMarkup(
      createElement(MetaGrid, { items: [{ label: 'Added', value: '17 Nov 2026' }] }),
    );
    expect(html).toBe(
      '<dl class="kaki-meta-grid"><div class="kaki-meta-grid__item"><dt>Added</dt><dd>17 Nov 2026</dd></div></dl>',
    );
  });
});
