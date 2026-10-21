import { describe, expect, it } from 'vitest';
import { inScope, InvalidWebsiteError, normaliseUrl, originsOf, parseWebsite } from './scope.js';

describe('parseWebsite (KB-13)', () => {
  it('takes the host without www as the domain, and adds https to a bare domain', () => {
    expect(parseWebsite('kakibakery.sg')).toEqual({
      url: 'https://kakibakery.sg/',
      domain: 'kakibakery.sg',
      subdomains: [],
      hosts: ['kakibakery.sg', 'www.kakibakery.sg'],
    });
    const s = parseWebsite('https://WWW.KakiBakery.sg/menu/#cakes', [
      ' Shop.kakibakery.sg ',
      'shop.kakibakery.sg',
      'www.kakibakery.sg',
    ]);
    expect(s).toMatchObject({
      url: 'https://www.kakibakery.sg/menu',
      domain: 'kakibakery.sg',
      subdomains: ['shop.kakibakery.sg'],
    });
    expect(originsOf(s)).toEqual([
      'https://kakibakery.sg',
      'https://www.kakibakery.sg',
      'https://shop.kakibakery.sg',
    ]);
  });

  it.each([
    ['ftp://kakibakery.sg', 'url'],
    ['https://user:pw@kakibakery.sg', 'url'],
    ['https://kakibakery.sg:8443/', 'url'],
    ['http://127.0.0.1/', 'url'],
    ['http://[::1]/', 'url'],
    ['http://localhost/', 'url'],
    ['not a url at all', 'url'],
    ['https://intranet/', 'url'],
  ])('refuses %s', (url, field) => {
    expect(() => parseWebsite(url)).toThrow(InvalidWebsiteError);
    try {
      parseWebsite(url);
    } catch (e) {
      expect((e as InvalidWebsiteError).field).toBe(field);
    }
  });

  it('refuses subdomains outside the domain and too many of them', () => {
    expect(() => parseWebsite('kakibakery.sg', ['evil.sg'])).toThrow(/not under/);
    expect(() => parseWebsite('kakibakery.sg', ['notkakibakery.sg'])).toThrow(/not under/);
    expect(() =>
      parseWebsite(
        'kakibakery.sg',
        Array.from({ length: 21 }, (_, i) => `s${i}.kakibakery.sg`),
      ),
    ).toThrow(/at most 20/);
  });
});

describe('normaliseUrl and inScope', () => {
  it.each([
    ['https://Bakery.sg/About/', 'https://bakery.sg/About'],
    ['https://bakery.sg/index.html', 'https://bakery.sg/'],
    ['https://bakery.sg/cakes/index.htm#top', 'https://bakery.sg/cakes'],
    ['https://bakery.sg/?a=1#x', 'https://bakery.sg/?a=1'],
    ['/faq', 'https://bakery.sg/faq'],
    ['mailto:hi@bakery.sg', null],
    ['javascript:void(0)', null],
    ['https://bakery.sg:8080/x', null],
    ['tel:+6591234567', null],
  ])('%s → %s', (href, out) => expect(normaliseUrl(href, 'https://bakery.sg/menu')).toBe(out));

  it('keeps pages on the scope hosts only, whatever the scheme', () => {
    const hosts = ['bakery.sg', 'www.bakery.sg', 'shop.bakery.sg'];
    expect(inScope('https://www.bakery.sg/a', hosts)).toBe(true);
    expect(inScope('http://shop.bakery.sg/', hosts)).toBe(true);
    expect(inScope('https://blog.bakery.sg/', hosts)).toBe(false);
    expect(inScope('https://bakery.sg.evil.com/', hosts)).toBe(false);
    expect(inScope('garbage', hosts)).toBe(false);
  });
});
