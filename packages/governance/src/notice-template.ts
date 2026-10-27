import type { NoticeTemplateFields } from './privacy.js';
import { SUB_PROCESSORS, TRANSFERS } from './registry.js';

/**
 * The hosted privacy notice (GOV-14 template; FEAT-058 §5.1, D7): pure functions from the
 * tenant's template fields to sections, and from sections to one static HTML page. The
 * template wording awaits legal review (D5); English only for now.
 */

export interface NoticeSection {
  heading: string;
  paragraphs: string[];
}

export interface NoticeDocument {
  title: string;
  sections: NoticeSection[];
  /** "Last updated 27 Oct 2026", in Singapore time. */
  lastUpdated: string;
}

export interface NoticeInput {
  businessName: string;
  uen: string | null;
  fields: NoticeTemplateFields;
  /** The current purpose statement, English. */
  purpose: string;
  /** When the notice wording was saved. */
  savedAt: Date;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `d MMM yyyy` in Singapore time (UTC+8, no daylight saving). */
export function formatSgDate(at: Date): string {
  const sg = new Date(at.getTime() + 8 * 3600_000);
  return `${sg.getUTCDate()} ${MONTHS[sg.getUTCMonth()]} ${sg.getUTCFullYear()}`;
}

/** Splits free text into paragraphs on blank lines; no markup survives (it is escaped later). */
const paragraphsOf = (text: string | null) =>
  (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

export function noticeSections(input: NoticeInput): NoticeDocument {
  const { businessName, uen, fields } = input;
  const contact = [
    `${fields.contactName}, ${fields.contactEmail}`,
    ...(fields.contactPhone ? [`Phone: ${fields.contactPhone}`] : []),
    ...(fields.address ? [`Address: ${fields.address}`] : []),
  ];
  const sections: NoticeSection[] = [
    {
      heading: 'Who we are',
      paragraphs: [
        uen ? `${businessName} (UEN ${uen}).` : `${businessName}.`,
        'This notice explains how we use the personal data you give us when you chat with us on our website or other channels.',
      ],
    },
    {
      heading: 'What we collect',
      paragraphs: [
        'The messages you send in the chat, the details you choose to give us (such as your name, phone number or email), and the pages you view on our website while chatting.',
      ],
    },
    { heading: 'Why we use it', paragraphs: [input.purpose] },
    {
      heading: 'Who processes it for us',
      paragraphs: [
        'Our chat assistant is run for us by KakiAgent, which processes your data only on our instructions. KakiAgent uses these services:',
        ...SUB_PROCESSORS.map((s) => `${s.name}: ${s.service.toLowerCase()} (${s.location}).`),
      ],
    },
    {
      heading: 'Where it is processed',
      paragraphs: [
        'Your data is stored in Singapore. Some processing happens outside Singapore:',
        ...TRANSFERS.map(
          (t) =>
            `${t.data}: sent to ${t.to} for ${t.purpose.toLowerCase()}. Safeguards: ${t.safeguard}. Kept: ${t.retention.toLowerCase()}.`,
        ),
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        'We keep your data only as long as we need it for the purpose above, or as the law requires, and then delete it.',
      ],
    },
    {
      heading: 'Your choices',
      paragraphs: [
        'You can ask to see or correct the personal data we hold about you, or withdraw your consent to our using it, by contacting us below.',
      ],
    },
    { heading: 'Contact us', paragraphs: contact },
  ];
  const extra = paragraphsOf(fields.extra);
  if (extra.length) sections.push({ heading: 'More from us', paragraphs: extra });
  return {
    title: `${businessName} privacy notice`,
    sections,
    lastUpdated: `Last updated ${formatSgDate(input.savedAt)}`,
  };
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** A complete HTML page, every value escaped; `css` is trusted (the token stylesheet). */
export function renderNoticeHtml(doc: NoticeDocument, css: string): string {
  const body = doc.sections
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.heading)}</h2>${s.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(doc.title)}</title>
<style>${css}</style>
</head>
<body>
<main>
<h1>${escapeHtml(doc.title)}</h1>
${body}
${doc.lastUpdated ? `<p class="updated">${escapeHtml(doc.lastUpdated)}</p>` : ''}
</main>
</body>
</html>
`;
}

/** The page's own rules, tokens only (design.md); appended to the token stylesheet. */
export const NOTICE_CSS = `
body { margin: 0; background: var(--color-bg-canvas); color: var(--color-text-primary); font-family: var(--font-family-sans); font-size: var(--type-body-size); line-height: var(--type-body-line); }
main { max-width: 42rem; margin: 0 auto; padding: var(--space-8) var(--space-4); }
h1 { font-size: var(--type-title-size); line-height: var(--type-title-line); font-weight: var(--type-title-weight); margin: 0 0 var(--space-4); }
h2 { font-size: var(--type-heading-size); line-height: var(--type-heading-line); font-weight: var(--type-heading-weight); margin: var(--space-6) 0 var(--space-2); }
p { margin: 0 0 var(--space-2); }
.updated { color: var(--color-text-secondary); font-size: var(--type-body-sm-size); margin-top: var(--space-6); }
`;
