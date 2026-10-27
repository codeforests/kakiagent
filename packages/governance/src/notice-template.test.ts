import { describe, expect, it } from 'vitest';
import { formatSgDate, noticeSections, renderNoticeHtml } from './notice-template.js';
import { TRANSFERS } from './registry.js';

const FIELDS = {
  contactName: 'Mei Lin',
  contactEmail: 'dpo@kakibakery.test',
  contactPhone: '+65 6123 4567',
  address: null,
  extra: null,
};
const input = (over: Partial<Parameters<typeof noticeSections>[0]> = {}) => ({
  businessName: 'Kaki Bakery',
  uen: '201912345K',
  fields: FIELDS,
  purpose: 'To reply to your enquiry.',
  savedAt: new Date('2026-10-26T17:30:00Z'), // 27 Oct, 01:30 in Singapore
  ...over,
});

describe('hosted privacy notice (GOV-14 template)', () => {
  it('builds the sections in order from the tenant, purpose and registry', () => {
    const doc = noticeSections(input());
    expect(doc.sections.map((s) => s.heading)).toEqual([
      'Who we are',
      'What we collect',
      'Why we use it',
      'Who processes it for us',
      'Where it is processed',
      'How long we keep it',
      'Your choices',
      'Contact us',
    ]);
    expect(doc.sections[0]!.paragraphs[0]).toBe('Kaki Bakery (UEN 201912345K).');
    expect(doc.sections[2]!.paragraphs).toEqual(['To reply to your enquiry.']);
    const where = doc.sections[4]!.paragraphs.join('\n');
    for (const t of TRANSFERS) expect(where).toContain(t.to);
    expect(doc.sections[4]!.paragraphs).toHaveLength(TRANSFERS.length + 1);
    expect(doc.sections[7]!.paragraphs).toEqual([
      'Mei Lin',
      { mailto: 'dpo@kakibakery.test' },
      'Phone: +65 6123 4567',
    ]);
    expect(doc).toMatchObject({
      title: 'Privacy notice · Kaki Bakery',
      heading: 'Privacy notice',
      subtitle: ['Kaki Bakery', 'UEN 201912345K'],
      footer: 'Hosted by KakiAgent for Kaki Bakery.',
    });
    expect(doc.lastUpdated).toBe('Last updated 27 Oct 2026');
  });

  it('omits the UEN when it is not set', () => {
    expect(noticeSections(input({ uen: null })).sections[0]!.paragraphs[0]).toBe('Kaki Bakery.');
  });

  it('formats dates in Singapore time', () => {
    expect(formatSgDate(new Date('2026-09-01T00:00:00Z'))).toBe('1 Sep 2026');
    expect(formatSgDate(new Date('2026-12-31T16:00:00Z'))).toBe('1 Jan 2027');
  });

  it('escapes every value and keeps no markup from the extra text', () => {
    const doc = noticeSections(
      input({
        businessName: 'Tom & Jerry\'s "Cakes"',
        fields: { ...FIELDS, extra: '<script>alert(1)</script>\n\n<a href="x">Second</a> para' },
      }),
    );
    expect(doc.sections.at(-1)).toEqual({
      heading: 'More from us',
      paragraphs: ['<script>alert(1)</script>', '<a href="x">Second</a> para'],
    });
    const html = renderNoticeHtml(doc, 'body{}');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a href="x"'); // the extra text's markup; the mailto link is the page's own
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Tom &amp; Jerry&#39;s &quot;Cakes&quot;');
  });

  it('renders one English page with one h1', () => {
    const html = renderNoticeHtml(noticeSections(input()), 'body{}');
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<style>body{}</style>');
    expect(html).toContain('<h1>Privacy notice</h1>');
    expect(html).toContain('<title>Privacy notice · Kaki Bakery</title>');
  });

  it('links the contact email with mailto:, its only link', () => {
    const html = renderNoticeHtml(noticeSections(input()), 'body{}');
    expect(html).toContain('<p><a href="mailto:dpo@kakibakery.test">dpo@kakibakery.test</a></p>');
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});
