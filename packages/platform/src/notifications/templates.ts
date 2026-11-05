import type { Email } from '../mailer.js';
import type { NotificationKind } from './kinds.js';
import { sgTimeOfDay } from './quiet.js';

/**
 * Alert and digest emails (LED-04; FEAT-052 §5.1). Only the event, the business and a link into
 * the signed-in dashboard: no visitor name, contact detail or message text (D12).
 */
export interface EmailContext {
  to: string;
  businessName: string;
  settingsLink: string;
}

export interface AlertItem {
  kind: NotificationKind;
  urgent: boolean;
  at: Date;
  link: string;
}

const SUBJECT: Record<NotificationKind, string> = {
  escalation: 'A customer wants to talk to a person',
  approval_pending: 'A reply is waiting for your approval',
  hot_lead: 'New hot lead',
  escalation_reminder: 'Reminder: a customer is still waiting for a person',
  approval_undeliverable: "An approved reply couldn't reach the customer",
  test: 'Test alert from KakiAgent',
};

const LINE: Record<NotificationKind, string> = {
  escalation: 'A customer asked to talk to a person.',
  approval_pending: 'A reply is waiting for your approval before it is sent.',
  hot_lead: 'A new hot lead came in.',
  escalation_reminder: 'A customer who asked for a person is still waiting.',
  approval_undeliverable:
    'A decision was made after the chat closed, and the customer left no email or phone. Contact them another way if you can.',
  test: 'This is a test alert. Your alert emails are working.',
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const footerText = (ctx: EmailContext) =>
  `You get this because of your notification settings for ${ctx.businessName}: ${ctx.settingsLink}`;

const footerHtml = (ctx: EmailContext) =>
  `<p><small>You get this because of your ` +
  `<a href="${escapeHtml(ctx.settingsLink)}">notification settings</a> for ${escapeHtml(ctx.businessName)}.</small></p>`;

const button = (link: string) =>
  `<p><a href="${escapeHtml(link)}"><strong>Open in KakiAgent</strong></a></p>`;

export function alertSubject(kind: NotificationKind, urgent: boolean, businessName: string) {
  return `${urgent ? 'Urgent: ' : ''}[${businessName}] ${SUBJECT[kind]}`;
}

export function alertEmail(item: AlertItem, ctx: EmailContext): Email {
  const line = LINE[item.kind];
  return {
    to: ctx.to,
    subject: alertSubject(item.kind, item.urgent, ctx.businessName),
    text: `${line}\n\nOpen in KakiAgent: ${item.link}\n\n${footerText(ctx)}\n`,
    html: `<p>${escapeHtml(line)}</p>${button(item.link)}${footerHtml(ctx)}`,
  };
}

/** One email for everything held during quiet hours, oldest first (AC-4). */
export function digestEmail(items: AlertItem[], ctx: EmailContext): Email {
  const sorted = [...items].sort((a, b) => a.at.getTime() - b.at.getTime());
  const n = sorted.length;
  const intro = `${n} ${n === 1 ? 'alert' : 'alerts'} came in while your quiet hours were on.`;
  const label = (i: AlertItem) =>
    `${sgTimeOfDay(i.at)}: ${i.urgent ? 'Urgent: ' : ''}${LINE[i.kind]}`;
  return {
    to: ctx.to,
    subject: `[${ctx.businessName}] ${n} ${n === 1 ? 'alert' : 'alerts'} while your quiet hours were on`,
    text:
      `${intro}\n\n` +
      sorted.map((i) => `- ${label(i)} ${i.link}`).join('\n') +
      `\n\n${footerText(ctx)}\n`,
    html:
      `<p>${escapeHtml(intro)}</p><ul>` +
      sorted
        .map((i) => `<li>${escapeHtml(label(i))} <a href="${escapeHtml(i.link)}">Open</a></li>`)
        .join('') +
      `</ul>${footerHtml(ctx)}`,
  };
}
