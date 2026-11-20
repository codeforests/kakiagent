import { sgToday, type DsrType } from '@kaki/contracts';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { auditCode } from '../payload.js';
import { auditDsr } from './requests.js';

/**
 * A visitor's "delete my data" (LED-07, UC-28 2a; FEAT-061 §5.5, D6), in the visitor zone: opens
 * one `conversation`-sourced request, linked to the conversation and its contact, with the
 * contact's identifiers copied when known. A second ask while one is live opens none.
 */
export async function openFromConversation(
  tx: Tx,
  tenantId: string,
  input: { conversationId: string; type: DsrType; now: Date },
): Promise<{ status: 'opened' | 'already_open'; requestId: string | null }> {
  const c = schema.conversations;
  const k = schema.contacts;
  const [conv] = await tx
    .select({
      contactId: c.contactId,
      name: k.name,
      email: k.email,
      phone: k.phone,
      telegramId: k.telegramId,
    })
    .from(c)
    .leftJoin(k, and(eq(k.tenantId, c.tenantId), eq(k.id, c.contactId)))
    .where(and(eq(c.tenantId, tenantId), eq(c.id, input.conversationId)));
  const r = schema.dsrRequests;
  // The visitor zone reads only these columns back (0059 grants).
  const [row] = await tx
    .insert(r)
    .values({
      tenantId,
      type: input.type,
      source: 'conversation',
      receivedOn: sgToday(input.now),
      conversationId: input.conversationId,
      contactId: conv?.contactId ?? null,
      requesterName: conv?.name ?? null,
      requesterEmail: conv?.email ?? null,
      requesterPhone: conv?.phone ?? null,
      requesterTelegramId: conv?.telegramId != null ? String(conv.telegramId) : null,
    })
    .onConflictDoNothing({
      target: [r.tenantId, r.conversationId],
      where: sql`status in ('open', 'verified')`,
    })
    .returning({ id: r.id });
  if (!row) return { status: 'already_open', requestId: null };
  await auditDsr(tx, tenantId, {
    event: 'opened',
    requestId: row.id,
    actor: { type: 'agent' },
    related: [{ type: 'conversation', id: input.conversationId }],
    payload: { type: auditCode(input.type), source: auditCode('conversation') },
  });
  return { status: 'opened', requestId: row.id };
}
