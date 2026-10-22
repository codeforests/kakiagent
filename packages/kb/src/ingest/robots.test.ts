import { describe, expect, it } from 'vitest';
import { parseRobots, robotsPolicy } from './robots.js';

const u = (path: string) => `https://bakery.sg${path}`;

describe('robots.txt (RFC 9309)', () => {
  it('uses the KakiAgentBot group over *, and * otherwise', () => {
    const body = `User-agent: *\nDisallow: /\n\nUser-agent: KakiAgentBot\nDisallow: /private/\n`;
    const p = parseRobots(body);
    expect(p.allowed(u('/menu'))).toBe(true);
    expect(p.allowed(u('/private/x'))).toBe(false);
    const star = parseRobots(`User-agent: Googlebot\nDisallow:\n\nUser-agent: *\nDisallow: /tmp`);
    expect(star.allowed(u('/tmp/a'))).toBe(false);
    expect(star.allowed(u('/menu'))).toBe(true);
  });

  it('applies the longest match, with allow winning a tie', () => {
    const p = parseRobots(
      `User-agent: *\nDisallow: /shop\nAllow: /shop/cakes\nDisallow: /a\nAllow: /a`,
    );
    expect(p.allowed(u('/shop/cups'))).toBe(false);
    expect(p.allowed(u('/shop/cakes/fudge'))).toBe(true);
    expect(p.allowed(u('/a'))).toBe(true);
  });

  it('supports * and $ and matches the query too', () => {
    const p = parseRobots(
      `User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?session=\nDisallow: /fish*`,
    );
    expect(p.allowed(u('/menu.pdf'))).toBe(false);
    expect(p.allowed(u('/menu.pdf?x=1'))).toBe(true);
    expect(p.allowed(u('/cart?session=1'))).toBe(false);
    expect(p.allowed(u('/fishcake'))).toBe(false);
    expect(p.allowed(u('/Fish'))).toBe(true);
  });

  it('groups consecutive user-agent lines, ignores comments and an empty disallow', () => {
    const p = parseRobots(
      `# hi\nUser-agent: other\nUser-agent: kakiagentbot # us\nDisallow: /x # no\n\nUser-agent: *\nDisallow:\n`,
    );
    expect(p.allowed(u('/x/1'))).toBe(false);
    expect(parseRobots(`User-agent: *\nDisallow:`).allowed(u('/anything'))).toBe(true);
  });

  it('caps crawl-delay at 5 s and always allows /robots.txt', () => {
    expect(parseRobots(`User-agent: *\nCrawl-delay: 30\nDisallow: /`).crawlDelay).toBe(5);
    expect(parseRobots(`User-agent: *\nCrawl-delay: 1.5`).crawlDelay).toBe(1.5);
    expect(parseRobots(`User-agent: *\nDisallow: /`).allowed(u('/robots.txt'))).toBe(true);
  });

  it('treats 4xx as allow-all and 5xx or unreachable as disallow-all', () => {
    expect(robotsPolicy({ status: 404, body: '' }).allowed(u('/menu'))).toBe(true);
    expect(robotsPolicy({ status: 503, body: '' }).allowed(u('/menu'))).toBe(false);
    expect(robotsPolicy(null).allowed(u('/menu'))).toBe(false);
    expect(
      robotsPolicy({ status: 200, body: 'User-agent: *\nDisallow: /p' }).allowed(u('/p')),
    ).toBe(false);
  });
});
