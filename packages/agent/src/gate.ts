import type { Tx } from '@kaki/db';
import { getConversation } from '@kaki/inbox';
import { visitorTenantState, type VisitorTenantState } from '@kaki/tenancy';

export type GateResult =
  | { open: true; tenant: VisitorTenantState }
  | { open: false; reason: 'paused' | 'not_ai' | 'missing'; tenant: VisitorTenantState | null };

/**
 * The AI send gate (ADR-013 decision 3): checked before every turn and before each
 * segment is released. Real now: the kill switch (fail closed when the tenant state
 * is missing) and the conversation's status. Channel live (FEAT-034) and the human
 * owner row (FEAT-043) plug in here.
 */
export async function aiAllowed(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<GateResult> {
  const tenant = await visitorTenantState(tx);
  if (!tenant || tenant.aiPaused) return { open: false, reason: 'paused', tenant };
  const conversation = await getConversation(tx, tenantId, conversationId);
  if (!conversation) return { open: false, reason: 'missing', tenant };
  if (conversation.status !== 'ai') return { open: false, reason: 'not_ai', tenant };
  return { open: true, tenant };
}
