import { normaliseSgPhone } from '@kaki/contracts/lead-check';
import { sql, type Tx } from '@kaki/db';
import { mergeContacts } from './merge.js';

/**
 * Contact identity (CHN-08; FEAT-039 §5.1). A contact's identifiers live in
 * `contact_identities`; contacts join automatically only on the same verified identifier.
 * Typed lead-form values are identities too, but never verified and never matched (D1).
 */
export type IdentityKind = 'email' | 'phone' | 'telegram';
export type IdentitySource = 'email' | 'telegram' | 'lead_form' | 'link';

export interface Identity {
  kind: IdentityKind;
  /** Normalised (`normaliseIdentity`). */
  value: string;
  source: IdentitySource;
  verified: boolean;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

/** Lower-case email, `+65…` phone, Telegram user ID digits; null when it isn't one. */
export function normaliseIdentity(kind: IdentityKind, raw: string): string | null {
  const s = raw.trim();
  if (kind === 'email') {
    const e = s.toLowerCase();
    return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
  }
  if (kind === 'phone') return normaliseSgPhone(s) || null;
  return /^[0-9]{1,20}$/.test(s) ? s : null;
}

/** Serialises every resolve, attach and add of one identifier in a tenant. */
const lockValue = (tx: Tx, tenantId: string, kind: IdentityKind, value: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`identity:${tenantId}:${kind}:${value}`}, 0))`,
  );

/** The active contact holding this identifier verified, if any. */
async function verifiedHolder(
  tx: Tx,
  tenantId: string,
  kind: IdentityKind,
  value: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const { rows } = await tx.execute<{ id: string; created_at: Date | string }>(sql`
    select k.id, k.created_at from contact_identities i
    join contacts k on k.tenant_id = i.tenant_id and k.id = i.contact_id
    where i.tenant_id = ${tenantId} and i.kind = ${kind} and i.value = ${value}
      and i.verified_at is not null and k.merged_into is null`);
  const r = rows[0];
  return r ? { id: r.id, createdAt: new Date(r.created_at) } : null;
}

const insertIdentity = (tx: Tx, tenantId: string, contactId: string, i: Identity) =>
  tx.execute<{ id: string }>(sql`
    insert into contact_identities (tenant_id, contact_id, kind, value, source, verified_at)
    values (${tenantId}, ${contactId}, ${i.kind}, ${i.value}, ${i.source},
      ${i.verified ? sql`now()` : sql`null`})
    on conflict do nothing returning id`);

function check(i: Identity): void {
  if (normaliseIdentity(i.kind, i.value) !== i.value)
    throw new Error(`contacts: ${i.kind} identity not normalised`);
  if (i.source === 'lead_form' && i.verified)
    throw new Error('contacts: a typed value is never verified');
  if (i.source === 'link' && !i.verified)
    throw new Error('contacts: a handoff link always proves its identifier');
}

/**
 * The contact of an identifier a channel brings (§5.1): for a verified one, the active
 * contact holding it verified; for an unverified From address of the email channel, the
 * contact of earlier unverified mail from it (D3). Otherwise a new contact with that display
 * value. Never matches a lead-form identity, and never across verified and unverified.
 */
export async function resolveContact(
  tx: Tx,
  tenantId: string,
  identity: Identity,
  seed: { name?: string | null; telegramUsername?: string | null } = {},
): Promise<string> {
  check(identity);
  if (!identity.verified && identity.source !== 'email')
    throw new Error('contacts: only verified identifiers and unverified mail resolve a contact');
  await lockValue(tx, tenantId, identity.kind, identity.value);
  const found = identity.verified
    ? await verifiedHolder(tx, tenantId, identity.kind, identity.value)
    : ((
        await tx.execute<{ id: string }>(sql`
          select k.id from contact_identities i
          join contacts k on k.tenant_id = i.tenant_id and k.id = i.contact_id
          where i.tenant_id = ${tenantId} and i.kind = 'email' and i.source = 'email'
            and i.verified_at is null and i.value = ${identity.value}
            and k.merged_into is null`)
      ).rows[0] ?? null);
  if (found) return found.id;
  const display =
    identity.kind === 'email'
      ? { email: identity.value, telegramId: null }
      : identity.kind === 'telegram'
        ? { email: null, telegramId: Number(identity.value) }
        : { email: null, telegramId: null };
  const { rows } = await tx.execute<{ id: string }>(sql`
    insert into contacts (tenant_id, name, email, phone, telegram_id, telegram_username)
    values (${tenantId}, ${seed.name?.trim().slice(0, 120) || null}, ${display.email},
      ${identity.kind === 'phone' ? identity.value : null}, ${display.telegramId},
      ${seed.telegramUsername?.slice(0, 32) || null})
    returning id`);
  const contactId = rows[0]!.id;
  await insertIdentity(tx, tenantId, contactId, identity);
  return contactId;
}

/**
 * Adds an identifier to a known contact (`insert … on conflict do nothing`). A verified value
 * another contact holds is left with it: joining two contacts is `attachVerified`'s job.
 */
export async function addIdentity(
  tx: Tx,
  tenantId: string,
  contactId: string,
  identity: Identity,
): Promise<void> {
  check(identity);
  if (identity.verified) await lockValue(tx, tenantId, identity.kind, identity.value);
  await insertIdentity(tx, tenantId, contactId, identity);
}

/**
 * Adds a verified identifier to a contact the caller already knows (FEAT-038's link token,
 * §5.1). If another active contact holds it verified, the two are merged automatically: the
 * older contact survives (D5), the merge is audited `contact.merged` with `automatic: true`
 * and can be undone. Returns the contact merged away, if any.
 */
export async function attachVerified(
  tx: Tx,
  tenantId: string,
  contactId: string,
  identity: Identity,
): Promise<{ mergedFrom: string | null; contactId: string }> {
  check(identity);
  if (!identity.verified) throw new Error('contacts: attachVerified needs a verified identifier');
  await lockValue(tx, tenantId, identity.kind, identity.value);
  const holder = await verifiedHolder(tx, tenantId, identity.kind, identity.value);
  if (holder?.id === contactId) return { mergedFrom: null, contactId };
  if (!holder) {
    await insertIdentity(tx, tenantId, contactId, identity);
    if (identity.kind === 'email')
      await tx.execute(sql`update contacts set email = ${identity.value}, updated_at = now()
        where tenant_id = ${tenantId} and id = ${contactId} and email is null`);
    return { mergedFrom: null, contactId };
  }
  const { rows } = await tx.execute<{ created_at: Date | string }>(
    sql`select created_at from contacts where tenant_id = ${tenantId} and id = ${contactId}`,
  );
  if (!rows[0]) throw new Error('contacts: no such contact');
  const mine = new Date(rows[0].created_at);
  const [survivorId, mergedId] =
    holder.createdAt.getTime() <= mine.getTime() ? [holder.id, contactId] : [contactId, holder.id];
  await mergeContacts(tx, { tenantId, survivorId, mergedId, automatic: true, actorId: null });
  return { mergedFrom: mergedId, contactId: survivorId };
}
