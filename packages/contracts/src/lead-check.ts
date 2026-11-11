/**
 * Lead-form checks without Zod (FEAT-049 D7): the widget's panel and the server run the same
 * rules, and the panel chunk stays within its budget (ADR-016). `@kaki/contracts/lead-check`.
 */

export const LEAD_FIELD_KEYS = [
  'name',
  'phone',
  'email',
  'need',
  'budget',
  'preferredTime',
] as const;
export type LeadFieldKey = (typeof LEAD_FIELD_KEYS)[number];
export type LeadFieldMode = 'off' | 'optional' | 'required';
export type LeadFieldError = 'required' | 'invalid';

/** Longest value per field, in characters. */
export const LEAD_FIELD_MAX: Record<LeadFieldKey, number> = {
  name: 120,
  phone: 40,
  email: 254,
  need: 1000,
  budget: 120,
  preferredTime: 120,
};

/**
 * A Singapore number in any common spelling (`9123 4567`, `+65 9123-4567`, `006591234567`)
 * → `+6591234567`; '' for empty input; null when it isn't an SG number (FEAT-009 D3).
 */
export function normaliseSgPhone(input: string): string | null {
  const s = input.replace(/[\s-]/g, '');
  if (s === '') return '';
  const local = s.startsWith('+65') ? s.slice(3) : s.startsWith('0065') ? s.slice(4) : s;
  return /^[3689][0-9]{7}$/.test(local) ? `+65${local}` : null;
}

// Zod 4's default email pattern, so `z.email()` and this agree.
const EMAIL_RE =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

/** `EMAIL_RE` unanchored: finds an address inside free text (FEAT-026 `cleanMemory`). */
export const EMAIL_IN_TEXT =
  /[A-Za-z0-9_'+\-.]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}/;

/** An SG number (`normaliseSgPhone`'s spellings) inside free text (FEAT-026 `cleanMemory`). */
export const SG_PHONE_IN_TEXT = /(?<![\d+])(?:(?:\+|00)65[\s-]?)?[3689]\d{3}[\s-]?\d{4}(?!\d)/;

/** An email address of at most 254 characters, after trimming. */
export function isEmail(input: string): boolean {
  const s = input.trim();
  return s.length <= 254 && EMAIL_RE.test(s);
}

export type LeadValues = Record<LeadFieldKey, string>;

export interface LeadCheck {
  /** Per-field codes; empty when the input is fine. */
  fields: Partial<Record<LeadFieldKey, LeadFieldError>>;
  /** Neither phone nor email given (D6). */
  needsContact: boolean;
  /** Trimmed values, phone as `+65XXXXXXXX`, email lower-cased; off fields ''. */
  value: LeadValues;
}

/**
 * Checks what a visitor typed against the business's field modes: required fields, SG phone,
 * email, lengths, and phone or email (D6). Off fields are ignored and cleared.
 */
export function checkLead(
  modes: readonly { key: LeadFieldKey; mode: LeadFieldMode }[],
  input: Partial<Record<LeadFieldKey, string | null | undefined>>,
): LeadCheck {
  const modeOf = new Map(modes.map((m) => [m.key, m.mode]));
  const fields: LeadCheck['fields'] = {};
  const value = {} as LeadValues;
  for (const key of LEAD_FIELD_KEYS) {
    const mode = modeOf.get(key) ?? 'off';
    let v = mode === 'off' ? '' : (input[key] ?? '').trim();
    if (v.length > LEAD_FIELD_MAX[key]) fields[key] = 'invalid';
    else if (key === 'phone' && v !== '') {
      const p = normaliseSgPhone(v);
      if (p === null) fields[key] = 'invalid';
      else v = p;
    } else if (key === 'email' && v !== '') {
      if (!isEmail(v)) fields[key] = 'invalid';
      else v = v.toLowerCase();
    }
    if (v === '' && mode === 'required') fields[key] = 'required';
    value[key] = v;
  }
  const needsContact = value.phone === '' && value.email === '' && !fields.phone && !fields.email;
  return { fields, needsContact, value };
}

/** True when the check found nothing to fix. */
export const leadOk = (c: LeadCheck) => Object.keys(c.fields).length === 0 && !c.needsContact;
