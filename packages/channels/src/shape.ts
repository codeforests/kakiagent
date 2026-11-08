/**
 * The capability-aware outbound shaper (CHN-01, ADR-011; FEAT-036 §5.3). Pure: a stored
 * message and the channel's capabilities in, the text the channel sends (or nothing) out.
 * Notices that only make sense inside the widget aren't sent; cards are dropped where the
 * channel has no rich content and their reply text stays (D7).
 */
import type { ChannelCapabilities } from './adapter.js';

/** System notices that mark the widget's own UI moments, never sent to an adapter channel. */
export const UNSENT_NOTICE_KINDS = ['staff_joined', 'staff_left', 'chat_ended', 'lead_captured'];

export interface ShapeInput {
  author: 'visitor' | 'agent' | 'staff' | 'system';
  body: string;
  notice: string | null;
  noticeKind: string | null;
  disclosure: string | null;
  card: Record<string, unknown> | null;
}

export interface ShapeContext {
  capabilities: ChannelCapabilities;
  businessName: string;
  /** GOV-14: the privacy notice the footer links; null → the business name only. */
  privacyUrl: string | null;
}

export type Shaped =
  { send: false; reason: 'visitor' | 'widget_notice' } | { send: true; text: string };

export function shapeOutbound(m: ShapeInput, ctx: ShapeContext): Shaped {
  if (m.author === 'visitor') return { send: false, reason: 'visitor' };
  if (m.author === 'system' && m.noticeKind && UNSENT_NOTICE_KINDS.includes(m.noticeKind))
    return { send: false, reason: 'widget_notice' };
  const parts: string[] = [];
  // AGT-11: the disclosure the first AI message carries goes first.
  if (m.disclosure) parts.push(m.disclosure.trim());
  const body = m.body.trim();
  if (body) parts.push(body);
  if (m.notice && m.notice.trim() !== body) parts.push(m.notice.trim());
  const footer = ctx.privacyUrl
    ? `${ctx.businessName} · Privacy notice: ${ctx.privacyUrl}`
    : ctx.businessName;
  let text = parts.join('\n\n');
  const room = ctx.capabilities.maxLength - footer.length - 6;
  if (text.length > room) text = `${text.slice(0, Math.max(0, room - 3)).trimEnd()}[…]`;
  return { send: true, text: `${text}\n\n-- \n${footer}` };
}
