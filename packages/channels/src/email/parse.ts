/**
 * Inbound email parsing (CHN-04; FEAT-036 §5.1). Pure: raw MIME in, a `ParsedEmail` out,
 * then `bodyText` strips the quoted history and signature so the agent and staff see only
 * what the customer wrote.
 */
import { simpleParser } from 'mailparser';

export interface ParsedAttachment {
  name: string;
  /** As the sender declared it; the scan sniffs the real type (KB-11). */
  contentType: string;
  size: number;
  content: Buffer;
}

export interface ParsedEmail {
  messageId: string | null;
  inReplyTo: string | null;
  /** Oldest first, as the References header lists them. */
  references: string[];
  from: { address: string; name: string | null } | null;
  subject: string;
  text: string | null;
  html: string | null;
  /** Header name (lower case) → its raw value; the first occurrence wins. */
  headers: Map<string, string>;
  /** The top-level MIME type, e.g. `multipart/report` for a DSN. */
  contentType: string;
  attachments: ParsedAttachment[];
  date: Date | null;
}

/** The contracts' message body limit (FEAT-036 §5.1). */
export const BODY_MAX = 4000;
/** Stored for an attachment-only email so staff see it; it schedules no turn (§5.1). */
export const NO_TEXT = '(no text)';

const ID = /<[^<>\s]+>/g;
const ids = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v.join(' ') : (v ?? '')).match(ID) ?? [];

export async function parseEmail(raw: Buffer | string): Promise<ParsedEmail> {
  const p = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const headers = new Map<string, string>();
  for (const h of p.headerLines) {
    if (headers.has(h.key)) continue;
    const i = h.line.indexOf(':');
    headers.set(h.key, (i < 0 ? '' : h.line.slice(i + 1)).replace(/\r?\n[ \t]+/g, ' ').trim());
  }
  const ct = p.headers.get('content-type');
  const contentType =
    typeof ct === 'object' && ct && 'value' in ct ? String(ct.value).toLowerCase() : 'text/plain';
  const from = p.from?.value[0];
  return {
    messageId: ids(p.messageId)[0] ?? null,
    inReplyTo: ids(p.inReplyTo)[0] ?? null,
    references: ids(p.references),
    from: from?.address
      ? { address: from.address.toLowerCase(), name: from.name ? from.name : null }
      : null,
    subject: (p.subject ?? '').trim(),
    text: p.text ?? null,
    html: typeof p.html === 'string' ? p.html : null,
    headers,
    contentType,
    attachments: p.attachments
      .filter((a) => a.contentDisposition !== 'inline' || Boolean(a.filename))
      .map((a) => ({
        name: a.filename ?? 'attachment',
        contentType: a.contentType,
        size: a.size,
        content: a.content,
      })),
    date: p.date ?? null,
  };
}

const htmlToText = (html: string) =>
  html
    .replace(/<div class="gmail_quote[\s\S]*$/i, '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** Where quoted history starts: the earliest match wins. */
const QUOTE_STARTS = [
  /^On [^\n]*(?:\n[^\n]*)?wrote:[ \t]*$/m, // Gmail, Apple Mail (may wrap onto a second line)
  /^[^\n]*于[^\n]*写道[:：][ \t]*$/m, // Gmail in Chinese
  /^-{2,}[ \t]*Original Message[ \t]*-{2,}/im, // Outlook desktop
  /^_{10,}[ \t]*$/m, // Outlook web's rule before "From: … Sent:"
  /^From:[^\n]*\n(?:[^\n]+\n){0,3}?Sent:[^\n]*$/m, // Outlook without the rule
];

/** The customer's own words: quoted history, `>` lines and a `-- ` signature removed (§5.1). */
export function bodyText(p: Pick<ParsedEmail, 'text' | 'html'>): string {
  let text = (p.text ?? (p.html ? htmlToText(p.html) : '')).replace(/\r\n?/g, '\n');
  let cut = text.length;
  for (const re of QUOTE_STARTS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  text = text.slice(0, cut);
  const sig = /^-- ?$/m.exec(text);
  if (sig) text = text.slice(0, sig.index);
  text = text
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 3).trimEnd()}[…]` : text;
}

/** Gmail's forwarding confirmation (D5): its code and link, shown on SCR-APP-038. */
export function forwardingConfirmation(
  p: Pick<ParsedEmail, 'from' | 'subject' | 'text'>,
): { code: string | null; link: string | null } | null {
  if (p.from?.address !== 'forwarding-noreply@google.com') return null;
  const text = p.text ?? '';
  const code =
    /Confirmation code:\s*(\d{6,12})/i.exec(text)?.[1] ?? /\(#(\d{6,12})\)/.exec(p.subject)?.[1];
  const link = /https:\/\/mail(?:-settings)?\.google\.com\/\S+/.exec(text)?.[0] ?? null;
  return { code: code ?? null, link };
}
