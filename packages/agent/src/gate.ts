import { visitorChannel, type VisitorChannel } from '@kaki/channels';
import type { Tx } from '@kaki/db';
import { getConversation } from '@kaki/inbox';
import { visitorTenantState, type VisitorTenantState } from '@kaki/tenancy';

export type GateResult =
  | { open: true; tenant: VisitorTenantState }
  | { open: false; reason: 'paused' | 'not_ai' | 'missing'; tenant: VisitorTenantState | null }
  | { open: false; reason: 'not_live'; tenant: VisitorTenantState; offline: VisitorChannel };

/**
 * The AI send gate (ADR-013 decision 3): checked before every turn and before each
 * segment is released. In order: the kill switch (fail closed when the tenant state is
 * missing, and it wins over everything else), the conversation and its status, then
 * whether the conversation's channel is live (ONB-10, FEAT-034). The human owner row
 * (FEAT-043) plugs in here.
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
  const channel = await visitorChannel(tx, conversation.channel);
  if (!channel.live) return { open: false, reason: 'not_live', tenant, offline: channel };
  return { open: true, tenant };
}
