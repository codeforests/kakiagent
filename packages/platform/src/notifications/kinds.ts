import { schema } from '@kaki/db';

/**
 * Alert kinds (LED-04; FEAT-052 §5.1). `ALERT_EVENTS` are the events a member can turn on or
 * off; `test` is the internal test alert (D11), never muted or held.
 *
 * Urgency is the producer's call (SRS §1.4, D6): a visitor-requested escalation, or an approval
 * within 30 minutes of its SLA. Urgent bypasses quiet hours only, never a muted event.
 */
export const ALERT_EVENTS = schema.ALERT_EVENTS;
export const NOTIFICATION_KINDS = schema.NOTIFICATION_KINDS;
export const CHANNELS = ['email'] as const;

export type AlertEvent = (typeof ALERT_EVENTS)[number];
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
/**
 * The event a kind is muted with (FEAT-044 D6): a reminder follows its escalation's mute, so
 * there is no separate preference. Null: never muted (the test alert).
 */
export function muteEvent(kind: NotificationKind): AlertEvent | null {
  if (kind === 'test') return null;
  if (kind === 'escalation_reminder') return 'escalation';
  return kind;
}
export type SubjectType = (typeof schema.NOTIFICATION_SUBJECTS)[number];

/** What an alert is about: a conversation, an approval, a lead, or (test alert) the user. */
export interface Subject {
  type: SubjectType;
  id: string;
}
