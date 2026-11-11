import { sql, type Tx } from '@kaki/db';
import { audit, auditId } from '@kaki/governance';

/**
 * Merge and undo (CHN-08; FEAT-039 §5.3). The moves happen in the SECURITY DEFINER functions
 * `contact_merge()` and `contact_unmerge()` (0055), so no app role re-keys consents itself;
 * this module maps their refusals and writes the audit entries (IDs and counts only, ADR-014).
 */
export class NotMergeable extends Error {
  override name = 'NotMergeable';
  constructor(readonly reason: 'same_contact' | 'merged') {
    super(`contacts: not mergeable (${reason})`);
  }
}

export class UndoBlocked extends Error {
  override name = 'UndoBlocked';
  constructor(readonly reason: 'already_undone' | 'survivor_merged') {
    super(`contacts: undo blocked (${reason})`);
  }
}

/** A contact or merge that isn't this tenant's (404). */
export class ContactNotFound extends Error {
  override name = 'ContactNotFound';
}

const sqlState = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
};

function mapError(err: unknown): never {
  switch (sqlState(err)) {
    case 'KC000':
      throw new ContactNotFound('contacts: not found');
    case 'KC001':
      throw new NotMergeable('same_contact');
    case 'KC002':
      throw new NotMergeable('merged');
    case 'KC003':
      throw new UndoBlocked('already_undone');
    case 'KC004':
      throw new UndoBlocked('survivor_merged');
    default:
      throw err;
  }
}

/** A savepoint, so a refusal leaves the caller's transaction usable. */
async function definer<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await tx.transaction(fn);
  } catch (err) {
    mapError(err);
  }
}

export interface Moved {
  conversations: string[];
  consents: string[];
  leads: string[];
  telegram_chats: (string | number)[];
  audit_pii: string[];
  identities: string[];
  superseded: string | null;
  filled: string[];
}

/** Merges `mergedId` into `survivorId` and audits `contact.merged`; returns the merge ID. */
export async function mergeContacts(
  tx: Tx,
  m: {
    tenantId: string;
    survivorId: string;
    mergedId: string;
    automatic: boolean;
    actorId: string | null;
  },
): Promise<{ mergeId: string; moved: Moved }> {
  const { mergeId, moved } = await definer(tx, async (sp) => {
    const { rows } = await sp.execute<{ id: string }>(
      sql`select contact_merge(${m.survivorId}, ${m.mergedId}, ${m.automatic}, ${m.actorId}) as id`,
    );
    const id = rows[0]!.id;
    const r = await sp.execute<{ moved: Moved }>(
      sql`select moved from contact_merges where tenant_id = ${m.tenantId} and id = ${id}`,
    );
    return { mergeId: id, moved: r.rows[0]!.moved };
  });
  await audit.append(tx, m.tenantId, {
    action: 'contact.merged',
    actorType: m.actorId ? 'user' : 'system',
    actorId: m.actorId ?? undefined,
    subjectType: 'contact',
    subjectId: m.survivorId,
    related: [{ type: 'contact', id: m.mergedId }],
    payload: {
      mergeId: auditId(mergeId),
      survivor: auditId(m.survivorId),
      merged: auditId(m.mergedId),
      automatic: m.automatic,
      // The counts moved (flat: audit payloads hold no nested objects).
      conversations: moved.conversations.length,
      consents: moved.consents.length,
      leads: moved.leads.length,
      identities: moved.identities.length,
    },
  });
  return { mergeId, moved };
}

/** Undoes a merge (D7) and audits `contact.unmerged`; returns the restored contact's ID. */
export async function undoMerge(
  tx: Tx,
  u: { tenantId: string; mergeId: string; actorId: string | null },
): Promise<{ survivorId: string; mergedId: string }> {
  const ids = await definer(tx, async (sp) => {
    await sp.execute(sql`select contact_unmerge(${u.mergeId}, ${u.actorId})`);
    const { rows } = await sp.execute<{ survivor_id: string; merged_id: string }>(
      sql`select survivor_id, merged_id from contact_merges where tenant_id = ${u.tenantId} and id = ${u.mergeId}`,
    );
    return { survivorId: rows[0]!.survivor_id, mergedId: rows[0]!.merged_id };
  });
  await audit.append(tx, u.tenantId, {
    action: 'contact.unmerged',
    actorType: u.actorId ? 'user' : 'system',
    actorId: u.actorId ?? undefined,
    subjectType: 'contact',
    subjectId: ids.survivorId,
    related: [{ type: 'contact', id: ids.mergedId }],
    payload: {
      mergeId: auditId(u.mergeId),
      survivor: auditId(ids.survivorId),
      merged: auditId(ids.mergedId),
    },
  });
  return ids;
}
