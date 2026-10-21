/**
 * The crawler's fixture site (FEAT-012 §5.8): a small bakery website with every case the
 * crawl must handle, plus variants. Pages are generated, so the large variants and the
 * variant robots files stay in one place. The fixture domain is `kakibakery.test`; the
 * dev stack and tests reach it through the worker's dev-only host map (§5.6).
 */
export const FIXTURE_DOMAIN = 'kakibakery.test';
/** A host the site links and redirects to, never in scope. */
export const ELSEWHERE = 'elsewhere.test';

export type FixtureVariant =
  | 'bakery'
  | 'disallow-all'
  | 'robots-5xx'
  /** Pages that try to reach private addresses (the request guard, D7). */
  | 'guard'
  | { pages: number };

export interface FixtureResponse {
  status: number;
  type?: string;
  body: string;
  headers?: Record<string, string>;
}

const page = (title: string, body: string, links: string[] = [], head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><nav>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join(' ')}</nav>${body}</body></html>`;
const html = (body: string): FixtureResponse => ({
  status: 200,
  type: 'text/html; charset=utf-8',
  body,
});

/** The products: the first 8 state GST, the last 4 don't (KB-15 → `unknown`). */
export const PRODUCTS = [
  ['chocolate-fudge', 'Chocolate fudge cake', '1 kg', '55.00', 'GST incl.'],
  ['pandan-chiffon', 'Pandan chiffon cake', '20 cm', '28.50', 'GST incl.'],
  ['ondeh-ondeh', 'Ondeh-ondeh cake', '1 kg', '62.00', 'GST incl.'],
  ['durian-crepe', 'Durian crepe box', '6 pieces', '38.00', 'GST incl.'],
  ['kueh-lapis', 'Kueh lapis', '500 g', '24.00', 'before GST'],
  ['pineapple-tarts', 'Pineapple tarts', '30 pieces', '32.00', 'GST incl.'],
  ['egg-tarts', 'Egg tarts', '6 pieces', '12.60', 'GST incl.'],
  ['sourdough', 'Sourdough loaf', '800 g', '9.80', 'GST incl.'],
  ['butter-cake', 'Butter cake', '1 kg', '26.00', null],
  ['red-velvet', 'Red velvet cake', '1 kg', '58.00', null],
  ['milo-dinosaur', 'Milo dinosaur cake', '1 kg', '60.00', null],
  ['bandung-cupcakes', 'Bandung cupcakes', '6 pieces', '15.00', null],
] as const;

export const productLine = ([, name, unit, price, gst]: (typeof PRODUCTS)[number]) =>
  `${name} (${unit}) — S$${price}${gst ? ` (${gst})` : ''}`;

const NEWS = Array.from({ length: 8 }, (_, i) => i + 1);
const MAIN_LINKS = [
  '/',
  '/about',
  '/contact',
  '/products',
  '/faq',
  '/policies/refund',
  '/policies/delivery',
  '/promotions',
  '/js-only',
  '/news',
];

function bakery(path: string): FixtureResponse | null {
  const product = /^\/products\/([a-z-]+)$/.exec(path);
  if (product) {
    const p = PRODUCTS.find(([slug]) => slug === product[1]);
    if (!p) return null;
    return html(
      page(
        `${p[1]} — Kaki Bakery`,
        `<h1>${p[1]}</h1><p>${productLine(p)}</p><p>Baked fresh every morning in our Tiong Bahru kitchen.</p>`,
        ['/products', '/'],
      ),
    );
  }
  const news = /^\/news\/(\d+)$/.exec(path);
  if (news) {
    const n = Number(news[1]);
    if (!NEWS.includes(n)) return null;
    return html(
      page(
        `News ${n} — Kaki Bakery`,
        `<h1>Bakery news ${n}</h1><p>Story number ${n} from our kitchen: what we baked this week and who baked it.</p>`,
        ['/news', ...(n < NEWS.length ? [`/news/${n + 1}`] : [])],
      ),
    );
  }
  const about =
    '<h1>About us</h1><p>Kaki Bakery has baked cakes and kueh in Tiong Bahru since 1998.</p>';
  switch (path) {
    case '/':
      return html(
        page(
          'Kaki Bakery',
          `<h1>Kaki Bakery</h1><p>Fresh cakes and kueh, baked daily in Singapore.</p>
           <p><a href="https://${ELSEWHERE}/hello">Our friends</a> ·
           <a href="/menu.pdf">Menu (PDF)</a> · <a href="/missing">Old page</a> ·
           <a href="/go-elsewhere">Partner shop</a> · <a href="/old-faq">Questions</a> ·
           <a href="/about-us">Our story</a> · <a href="/private/staff">Staff</a> ·
           <a href="/private/recipes">Recipes</a> · <a href="mailto:hello@${FIXTURE_DOMAIN}">Mail</a> ·
           <a href="#top">Top</a></p>`,
          MAIN_LINKS,
        ),
      );
    case '/about':
      return html(page('About — Kaki Bakery', about, MAIN_LINKS));
    case '/about-us':
      // The same text as /about under another URL: a duplicate by content.
      return html(page('About — Kaki Bakery', about, MAIN_LINKS));
    case '/contact':
      return html(
        page(
          'Contact — Kaki Bakery',
          '<h1>Contact</h1><p>Visit us at 55 Tiong Bahru Road. WhatsApp us to order.</p>',
          MAIN_LINKS,
        ),
      );
    case '/products':
      return html(
        page(
          'Products — Kaki Bakery',
          `<h1>Our cakes</h1><ul>${PRODUCTS.map(
            ([slug, name]) => `<li><a href="/products/${slug}">${name}</a></li>`,
          ).join('')}</ul>`,
          MAIN_LINKS,
        ),
      );
    case '/faq':
      return html(
        page(
          'FAQ — Kaki Bakery',
          `<h1>Questions</h1>
           <p>Q: Do you have eggless cakes?<br>A: Yes, the butter cake and pandan chiffon come eggless. Order 3 days ahead.</p>
           <p>Q: Are your cakes halal?<br>A: Our kitchen is not halal-certified, but we use no pork or lard.</p>
           <p>Q: Can I collect on Sundays?<br>A: Yes, collection is from 9 am to 1 pm on Sundays.</p>`,
          MAIN_LINKS,
        ),
      );
    case '/policies/refund':
      return html(
        page(
          'Refund policy — Kaki Bakery',
          '<h1>Refunds</h1><p>Refund policy: Cancel at least 2 days before collection for a full refund; later cancellations get store credit.</p>',
          MAIN_LINKS,
        ),
      );
    case '/policies/delivery':
      return html(
        page(
          'Delivery — Kaki Bakery',
          '<h1>Delivery</h1><p>Delivery policy: Islandwide delivery is S$15, free for orders above S$120.</p>',
          MAIN_LINKS,
        ),
      );
    case '/promotions':
      return html(
        page(
          'Promotions — Kaki Bakery',
          '<h1>This month</h1><p>Promotion: Christmas log cake — 15% off all log cakes until 2099-12-26</p>',
          MAIN_LINKS,
        ),
      );
    case '/js-only':
      // Rendered only by JavaScript, from a sub-resource (KB-01: JavaScript pages).
      return html(
        page(
          'Kaya toast — Kaki Bakery',
          '<main id="app"></main>',
          [],
          '<script src="/app.js" defer></script>',
        ),
      );
    case '/app.js':
      return {
        status: 200,
        type: 'text/javascript',
        body: `fetch('/menu.json').then((r) => r.json()).then((m) => {
  const app = document.getElementById('app');
  app.innerHTML = '<h1>' + m.title + '</h1><p>' + m.line + '</p>' +
    '<a href="/products">All products</a>';
});`,
      };
    case '/menu.json':
      return {
        status: 200,
        type: 'application/json',
        body: JSON.stringify({ title: 'Kaya toast', line: 'Kaya toast box (4 sets) — S$12.00' }),
      };
    case '/news':
      return html(
        page(
          'News — Kaki Bakery',
          '<h1>News</h1>',
          NEWS.map((n) => `/news/${n}`),
        ),
      );
    case '/old-faq':
      return { status: 301, body: '', headers: { location: '/faq' } };
    case '/go-elsewhere':
      return { status: 302, body: '', headers: { location: `https://${ELSEWHERE}/shop` } };
    case '/menu.pdf':
      return { status: 200, type: 'application/pdf', body: '%PDF-1.4 fixture' };
    case '/private/staff':
    case '/private/recipes':
      return html(page('Private', '<p>Staff only.</p>'));
    case '/logo.png':
      return { status: 200, type: 'image/png', body: '' };
    default:
      return null;
  }
}

/** A site of `n` linked pages for the plan cap and the 200-page timing (AC-3, AC-11). */
function large(n: number, path: string): FixtureResponse | null {
  const m = /^\/(?:p\/(\d+))?$/.exec(path);
  if (!m) return null;
  const i = m[1] ? Number(m[1]) : 0;
  if (i >= n) return null;
  const links = Array.from({ length: 5 }, (_, k) => i * 5 + k + 1)
    .filter((j) => j < n)
    .map((j) => `/p/${j}`);
  return html(
    page(
      `Page ${i}`,
      `<h1>Page ${i}</h1><p>Product ${i} (1 box) — S$${(10 + (i % 50)).toFixed(2)}</p>`,
      links,
    ),
  );
}

/** One response from the fixture site, or null for a 404. `port` is the server's own port. */
export function fixtureResponse(
  variant: FixtureVariant,
  path: string,
  port: number,
): FixtureResponse | null {
  if (path === '/robots.txt') {
    if (variant === 'robots-5xx') return { status: 503, type: 'text/plain', body: 'busy' };
    const body =
      variant === 'disallow-all'
        ? 'User-agent: *\nDisallow: /\n'
        : 'User-agent: *\nDisallow: /private/\n\nUser-agent: OtherBot\nDisallow: /\n';
    return { status: 200, type: 'text/plain', body };
  }
  if (typeof variant === 'object') return large(variant.pages, path);
  if (variant === 'guard') {
    if (path === '/')
      return html(
        page(
          'Guarded',
          // A sub-resource on a loopback address and a link to a host resolving privately.
          `<p>Guarded page with a script from a private address.</p>
           <script src="http://localhost:${port}/secret.js"></script>`,
          ['/next'],
        ),
      );
    if (path === '/next') return html(page('Next', '<p>The next guarded page, reachable.</p>'));
    if (path === '/secret.js') return { status: 200, type: 'text/javascript', body: '' };
    return null;
  }
  return bakery(path);
}

/** The bakery site's crawl, as AC-2 expects it (path → status and reason). */
export const BAKERY_EXPECTED = {
  included: [
    '/',
    '/about',
    '/contact',
    '/products',
    '/faq',
    '/policies/refund',
    '/policies/delivery',
    '/promotions',
    '/js-only',
    '/news',
    ...PRODUCTS.map(([slug]) => `/products/${slug}`),
    ...NEWS.map((n) => `/news/${n}`),
  ],
  excluded: {
    '/about-us': 'duplicate',
    '/old-faq': 'duplicate',
    '/go-elsewhere': 'off_domain_redirect',
    '/menu.pdf': 'not_html',
    '/private/staff': 'robots',
    '/private/recipes': 'robots',
  },
  failed: { '/missing': 'http_error' },
} as const;
