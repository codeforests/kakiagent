import { visitorChannel, type VisitorChannel } from '@kaki/channels';
import type { Tx } from '@kaki/db';
import {
  agentMessagesSince,
  getConversation,
  ownerOf,
  type ConversationStatus,
} from '@kaki/inbox';
import { visitorTenantState, type VisitorTenantState } from '@kaki/tenancy';

export type GateResult =
  | { open: true; tenant: VisitorTenantState }
  | { open: false; reason: 'paused' | 'not_ai' | 'missing'; tenant: VisitorTenantState | null }
  | { open: false; reason: 'not_live'; tenant: VisitorTenantState; offline: VisitorChannel }
  | { open: false; reason: 'reply_cap'; tenant: VisitorTenantState };

/** The reply cap's window (FEAT-036 D3). */
export const REPLY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the AI may speak in a conversation in this state (ADR-013 d3; FEAT-042 D2):
 * escalated and waiting-for-approval conversations are still answered until a person
 * takes over.
 */
export const statusOpen = (status: ConversationStatus) => status !== 'human' && status !== 'closed';

/**
 * The conversation half of the gate (FEAT-043 §5.2, D2): open only when the status allows it
 * and nobody owns it. Either one closes it, so a stray owner row on an `ai` status still does.
 */
export const conversationOpen = (status: ConversationStatus, hasOwner: boolean) =>
  statusOpen(status) && !hasOwner;

/**
 * The AI send gate (ADR-013 decision 3): checked before every turn and before each
 * segment is released. In order: the kill switch (fail closed when the tenant state is
 * missing, and it wins over everything else), the conversation and its status, then
 * whether the conversation's channel is live (ONB-10, FEAT-034). A human owner
 * (`conversation_owners`, FEAT-043) closes it like a `human` status. Last, a channel with
 * an AI reply cap closes once the conversation has had that many AI replies in 24 h
 * (FEAT-036 §5.4, D3); no kind check, any capped channel behaves the same.
 */
export async function aiAllowed(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  now: Date = new Date(),
): Promise<GateResult> {
  const tenant = await visitorTenantState(tx);
  if (!tenant || tenant.aiPaused) return { open: false, reason: 'paused', tenant };
  const conversation = await getConversation(tx, tenantId, conversationId);
  if (!conversation) return { open: false, reason: 'missing', tenant };
  if (!statusOpen(conversation.status)) return { open: false, reason: 'not_ai', tenant };
  const owner = await ownerOf(tx, tenantId, conversationId);
  if (!conversationOpen(conversation.status, owner !== null))
    return { open: false, reason: 'not_ai', tenant };
  const channel = await visitorChannel(tx, conversation.channel);
  if (!channel.live) return { open: false, reason: 'not_live', tenant, offline: channel };
  if (channel.aiReplyCap !== null) {
    const since = new Date(now.getTime() - REPLY_CAP_WINDOW_MS);
    const sent = await agentMessagesSince(tx, tenantId, conversationId, since);
    if (sent >= channel.aiReplyCap) return { open: false, reason: 'reply_cap', tenant };
  }
  return { open: true, tenant };
}
