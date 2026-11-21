import {
  DSR_CLOSED_STATUSES,
  DSR_DUE_SOON_DAYS,
  type DsrDueState,
  type DsrStatus,
} from '@kaki/contracts';

/**
 * Due dates and masked labels for data-subject requests (FEAT-061 §5.1). Pure: dates are
 * Singapore calendar days as `YYYY-MM-DD` (`sgToday` in contracts).
 */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isClosedStatus(status: DsrStatus): boolean {
  return (DSR_CLOSED_STATUSES as readonly string[]).includes(status);
}

/** Closed → `closed`; past the due day → `overdue`; within 7 days of it → `due_soon`. */
export function dueState(r: { status: DsrStatus; dueOn: string }, today: string): DsrDueState {
  if (isClosedStatus(r.status)) return 'closed';
  if (today > r.dueOn) return 'overdue';
  if (today >= addDays(r.dueOn, -DSR_DUE_SOON_DAYS)) return 'due_soon';
  return 'ok';
}

/** `DSR-1A2B3C4D`: the first eight hex digits of the ID. */
export function dsrRef(id: string): string {
  return `DSR-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

/** `m•••@gmail.com`. */
export function maskEmailValue(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

/** `+65 ••••1234`. */
export function maskPhoneValue(phone: string): string {
  return `+65 ••••${phone.slice(-4)}`;
}

/** `••••6789`. */
export function maskTelegramValue(id: string): string {
  return `••••${id.slice(-4)}`;
}

/** `M.T.`: the initials of up to three words. */
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => `${[...w][0]!.toUpperCase()}.`)
    .join('');
}

export interface RequesterValues {
  name: string | null;
  email: string | null;
  phone: string | null;
  telegramId: string | null;
}

/** The list label: initials and the first identifier, masked. */
export function requesterLabel(r: RequesterValues): string {
  const id = r.email
    ? maskEmailValue(r.email)
    : r.phone
      ? maskPhoneValue(r.phone)
      : r.telegramId
        ? `Telegram ${maskTelegramValue(r.telegramId)}`
        : null;
  const who = r.name ? initials(r.name) : null;
  if (who && id) return `${who} · ${id}`;
  return who ?? id ?? 'From a conversation';
}

/** What the request keeps once the subject's data is deleted (D3). */
export function maskedRequester(r: RequesterValues): RequesterValues {
  return {
    name: r.name ? initials(r.name) : null,
    email: r.email ? maskEmailValue(r.email) : null,
    phone: r.phone ? maskPhoneValue(r.phone) : null,
    telegramId: r.telegramId ? maskTelegramValue(r.telegramId) : null,
  };
}
