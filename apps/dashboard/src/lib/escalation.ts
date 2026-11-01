import type { EscalationRouting, EscalationRoutingBody, InboxMember } from '@kaki/contracts';
import { ApiError } from './api.ts';

/** Escalation routing on Team (FEAT-044 ui-design SCR-APP-045). */
export const ESCALATION_ROUTING_KEY = ['escalation-routing'] as const;

export interface RoutingForm {
  mode: EscalationRouting['mode'];
  personUserId: string;
  minutes: string;
}

export type RoutingErrors = Partial<Record<'personUserId' | 'reminderMinutes', string>>;

export const routingForm = (r: EscalationRouting): RoutingForm => ({
  mode: r.mode,
  personUserId: r.personUserId ?? '',
  minutes: String(r.reminderMinutes),
});

const minutesOf = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

export function routingErrors(f: RoutingForm): RoutingErrors {
  const errors: RoutingErrors = {};
  if (f.mode === 'person' && !f.personUserId) errors.personUserId = 'Choose a person';
  const m = minutesOf(f.minutes);
  if (!(m >= 1 && m <= 240)) errors.reminderMinutes = 'Enter a number from 1 to 240';
  return errors;
}

export const routingBody = (f: RoutingForm): EscalationRoutingBody => ({
  mode: f.mode,
  personUserId: f.mode === 'person' ? f.personUserId || null : null,
  reminderMinutes: minutesOf(f.minutes),
});

/** Save stays disabled until something changed (person only counts in person mode). */
export function routingChanged(f: RoutingForm, saved: EscalationRouting): boolean {
  const s = routingForm(saved);
  return (
    f.mode !== s.mode ||
    f.minutes.trim() !== s.minutes ||
    (f.mode === 'person' && f.personUserId !== s.personUserId)
  );
}

const personName = (id: string | null, members: InboxMember[] | undefined) =>
  members?.find((m) => m.userId === id)?.name ?? 'A team member';

/** The read-only card's text (Agents). */
export function routingSummary(r: EscalationRouting, members: InboxMember[] | undefined): string {
  const who =
    r.mode === 'person' && !r.personInactive
      ? `Escalations go to ${personName(r.personUserId, members)}.`
      : 'Escalations take turns across the team.';
  return `${who} Reminders after ${r.reminderMinutes} ${r.reminderMinutes === 1 ? 'minute' : 'minutes'}.`;
}

/** The person-inactive warning; null when routing is as saved. */
export function personInactiveText(
  r: EscalationRouting,
  members: InboxMember[] | undefined,
): string | null {
  if (!r.personInactive) return null;
  const name = members?.find((m) => m.userId === r.personUserId)?.name ?? 'The person you chose';
  return `${name} is no longer on the team, so escalations are taking turns. Choose someone else or keep taking turns.`;
}

/** Field errors from a refused save; null means a network or unknown failure. */
export function routingSaveErrors(err: unknown): RoutingErrors | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'person_not_member')
    return { personUserId: 'That person is no longer on the team. Choose someone else.' };
  if (err.code === 'invalid_routing') {
    const fields = (err.details.fields ?? {}) as Record<string, string>;
    const errors: RoutingErrors = {};
    if (fields.personUserId) errors.personUserId = 'Choose a person';
    if (fields.reminderMinutes) errors.reminderMinutes = 'Enter a number from 1 to 240';
    return Object.keys(errors).length ? errors : null;
  }
  return null;
}
