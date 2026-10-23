/**
 * What the file fixtures say (FEAT-015 §5.9), in the fake extractor's patterns, so the
 * generator writes them and the tests expect them from one place.
 */

export const PRICE_LIST_PAGES = [
  [
    'Kaki Bakery price list',
    'Chocolate fudge cake (1 kg) — S$55.00 (GST incl.)',
    'Pandan chiffon cake (20 cm) — S$28.50 (GST incl.)',
    'Kueh lapis (500 g) — S$24.00 (before GST)',
    'Butter cake (1 kg) — S$26.00',
  ],
  [
    'Questions and policies',
    'Q: Do you deliver on Sundays?',
    'A: Yes, from 10 am to 6 pm.',
    'Refund policy: Full refund if you cancel 48 hours before collection.',
  ],
  ['Offers', 'Promotion: Mid-Autumn set — 20% off mooncake boxes until 2026-12-31'],
];

/** The two image-only pages of `scanned-menu.pdf`, OCR'd. */
export const SCANNED_MENU_PAGES = [
  ['Menu', 'Egg tarts (6 pieces) - S$12.60', 'Sourdough loaf (800 g) - S$9.80'],
  ['Cakes', 'Red velvet cake (1 kg) - S$58.00', 'Milo dinosaur cake (1 kg) - S$60.00'],
];

/** `menu-photo.png` and `menu-photo.jpg`. */
export const MENU_PHOTO_LINES = [
  'Pineapple tarts (30 pieces) - S$32.00',
  'Durian crepe box (6 pieces) - S$38.00',
];

/** `chinese-notice.png` (simplified Chinese, OCR `chi_sim`). */
export const CHINESE_NOTICE = '本店营业时间为每天上午九点至晚上九点，星期一休息。';

/** `faq.docx`: paragraphs, a tab, a line break and a table. */
export const FAQ_DOCX = {
  paragraphs: [
    'Kaki Bakery FAQ',
    'Q: Can I collect my cake on the same day?',
    'A: Yes, for orders before 11 am.',
    'Q: Do you have halal certification?',
    'A: Our kitchen is halal certified.',
  ],
  table: [
    ['Item', 'Price'],
    ['Ondeh-ondeh cake (1 kg) — S$62.00 (GST incl.)', 'whole'],
  ],
};

/** `promo.pptx`: one page per slide. */
export const PROMO_SLIDES = [
  ['Kaki Bakery', 'Festive specials'],
  ['Promotion: Christmas log cake — S$48.00 for members until 2026-12-25'],
  ['Delivery policy: Free delivery for orders above S$80.'],
];

/** `policies.txt`. */
export const POLICIES_TXT = [
  'Kaki Bakery policies',
  '',
  'Booking policy: Book tasting sessions at least 3 days ahead.',
  'Payment policy: We accept PayNow, cards and cash.',
  '',
].join('\r\n');

/** The user password of `protected.pdf` (D3: never asked for, never tried). */
export const PROTECTED_PASSWORD = 'kaki-secret';

/**
 * EICAR's test file, built from two halves at run time so no checkout holds it and trips
 * a virus scanner (§5.9).
 */
export const eicar = () =>
  new TextEncoder().encode(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  );
