import { and, asc, eq, gte, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import { SettingsConflictError } from './assistant.js';
import { WeeklyHours } from './hours.js';
import { isSgPublicHoliday } from './sg-holidays.js';

const { businessProfiles, holidays, tenants } = schema;

/**
 * The business profile (ONB-03; FEAT-009 §5.1): the `business_profiles` row, the
 * tenant's name (D1) and its holiday exceptions from today on (D4). Every tenant has a
 * row from sign-up (FEAT-005), so there are no defaults to fall back to.
 */

export const INDUSTRIES = [
  'fnb',
  'retail',
  'beauty_wellness',
  'education',
  'professional_services',
  'home_services',
  'other',
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const PROFILE_LANGUAGES = ['en', 'zh', 'ms', 'ta'] as const;
export type ProfileLanguage = (typeof PROFILE_LANGUAGES)[number];

export interface HolidayException {
  /** A Singapore calendar day, `YYYY-MM-DD`. */
  day: string;
  kind: 'open' | 'closed';
  label: string | null;
}

/** What the owner edits: the whole document (D7). */
export interface ProfileInput {
  name: string;
  uen: string | null;
  industry: Industry | null;
  contactEmail: string | null;
  contactPhone: string | null;
  languages: ProfileLanguage[];
  gstRegistered: boolean;
  hours: WeeklyHours | null;
  openOnPublicHolidays: boolean;
  exceptions: HolidayException[];
}

export interface BusinessProfile extends ProfileInput {
  version: number;
  updatedAt: Date;
}

/** A value the contract should have refused reached the module (→ 400). */
export class InvalidProfileError extends Error {}

/** The profile with the exceptions from `today` (SGT, `YYYY-MM-DD`) on, by day. */
export async function getBusinessProfile(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<BusinessProfile> {
  const [row] = await tx
    .select({ p: businessProfiles, name: tenants.name })
    .from(businessProfiles)
    .innerJoin(tenants, eq(tenants.id, businessProfiles.tenantId))
    .where(eq(businessProfiles.tenantId, tenantId));
  if (!row) throw new Error('business profile missing');
  const days = await tx
    .select({ day: holidays.day, kind: holidays.kind, label: holidays.label })
    .from(holidays)
    .where(and(eq(holidays.tenantId, tenantId), gte(holidays.day, today)))
    .orderBy(asc(holidays.day));
  const { p } = row;
  return {
    version: p.version,
    name: row.name,
    uen: p.uen,
    industry: (INDUSTRIES as readonly string[]).includes(p.industry ?? '')
      ? (p.industry as Industry)
      : null,
    contactEmail: p.contactEmail,
    contactPhone: p.contactPhone,
    languages: p.languages.filter((l): l is ProfileLanguage =>
      (PROFILE_LANGUAGES as readonly string[]).includes(l),
    ),
    gstRegistered: p.gstRegistered,
    // Invalid hours read as not set, as in `visitorTenantState`.
    hours: p.hours === null ? null : (WeeklyHours.safeParse(p.hours).data ?? null),
    openOnPublicHolidays: p.openOnPublicHolidays,
    exceptions: days,
    updatedAt: p.updatedAt,
  };
}

/**
 * The exceptions that change the result (D4), in day order. An `open` day must be a
 * public holiday and every day must be from `today` on; anything else is refused.
 */
export function effectiveExceptions(
  exceptions: HolidayException[],
  openOnPublicHolidays: boolean,
  today: string,
): HolidayException[] {
  const seen = new Set<string>();
  const kept: HolidayException[] = [];
  for (const e of [...exceptions].sort((a, b) => a.day.localeCompare(b.day))) {
    if (seen.has(e.day)) throw new InvalidProfileError(`duplicate day ${e.day}`);
    seen.add(e.day);
    if (e.day < today) throw new InvalidProfileError(`past day ${e.day}`);
    const holiday = isSgPublicHoliday(e.day);
    if (e.kind === 'open' && !holiday) throw new InvalidProfileError(`open on ${e.day}`);
    // Already the rule's result: open on a holiday the business opens anyway, or closed
    // on one it closes anyway.
    if (holiday && (e.kind === 'open') === openOnPublicHolidays) continue;
    kept.push(e);
  }
  return kept;
}

const FIELDS = [
  ['name', 'name'],
  ['uen', 'uen'],
  ['industry', 'industry'],
  ['contactEmail', 'contact_email'],
  ['contactPhone', 'contact_phone'],
  ['languages', 'languages'],
  ['gstRegistered', 'gst_registered'],
  ['hours', 'hours'],
  ['openOnPublicHolidays', 'open_on_public_holidays'],
  ['exceptions', 'exceptions'],
] as const;

/**
 * Saves the whole profile if `version` is still current (D7): the row goes from version
 * n to n + 1, the tenant is renamed, and the exceptions from `today` on are replaced (past
 * ones are kept). A stale version raises `SettingsConflictError` and changes nothing. The
 * audit entry names the changed fields, never their values (ADR-014, NFR-11).
 */
export async function saveBusinessProfile(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    version: number;
    profile: ProfileInput;
    today: string;
  },
): Promise<BusinessProfile> {
  const { tenantId, version, profile, today } = input;
  if (profile.hours !== null && !WeeklyHours.safeParse(profile.hours).success)
    throw new InvalidProfileError('hours');
  const exceptions = effectiveExceptions(profile.exceptions, profile.openOnPublicHolidays, today);
  const before = await getBusinessProfile(tx, tenantId, today);
  const [row] = await tx
    .update(businessProfiles)
    .set({
      uen: profile.uen,
      industry: profile.industry,
      contactEmail: profile.contactEmail,
      contactPhone: profile.contactPhone,
      languages: profile.languages,
      gstRegistered: profile.gstRegistered,
      hours: profile.hours,
      openOnPublicHolidays: profile.openOnPublicHolidays,
      version: sql`${businessProfiles.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(businessProfiles.tenantId, tenantId), eq(businessProfiles.version, version)))
    .returning({ version: businessProfiles.version });
  if (!row) throw new SettingsConflictError('business profile changed');
  if (profile.name !== before.name)
    await tx.update(tenants).set({ name: profile.name }).where(eq(tenants.id, tenantId));
  await tx.delete(holidays).where(and(eq(holidays.tenantId, tenantId), gte(holidays.day, today)));
  if (exceptions.length)
    await tx.insert(holidays).values(exceptions.map((e) => ({ tenantId, ...e })));
  const saved = await getBusinessProfile(tx, tenantId, today);
  const changed = FIELDS.filter(
    ([key]) => JSON.stringify(before[key]) !== JSON.stringify(saved[key]),
  ).map(([, code]) => auditCode(code));
  await audit.append(tx, tenantId, {
    action: 'settings.profile_updated',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'business_profile',
    subjectId: tenantId,
    payload: { version: saved.version, fields: changed },
  });
  return saved;
}
