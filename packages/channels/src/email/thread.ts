/**
 * Email threading (CHN-04 "threads correctly in Gmail and Outlook"; FEAT-036 §5.1). Subject
 * threading is never used: two customers can both write "Enquiry".
 */
import type { ParsedEmail } from './parse.js';

/** The thread's root: the first References entry, else In-Reply-To, else the message's own ID. */
export function threadKey(
  p: Pick<ParsedEmail, 'references' | 'inReplyTo' | 'messageId'>,
): string | null {
  return p.references[0] ?? p.inReplyTo ?? p.messageId;
}

/** The IDs a reply may point at: References ∪ In-Reply-To (Outlook trims References). */
export function lookupIds(p: Pick<ParsedEmail, 'references' | 'inReplyTo'>): string[] {
  return [...new Set([...p.references, ...(p.inReplyTo ? [p.inReplyTo] : [])])];
}

/** `Re: <subject>` once, whatever prefix the client used (Re, RE, AW, 回复). */
export function replySubject(subject: string): string {
  const bare = subject.replace(/^(\s*(re|aw|fwd?|回复|答复)\s*[:：]\s*)+/i, '').trim();
  return `Re: ${bare || '(no subject)'}`;
}

/** The subject stored on the thread: no reply prefixes, at most 200 characters. */
export function threadSubject(subject: string): string {
  return replySubject(subject).slice(4).slice(0, 200);
}
