import { withTenant, type ZoneDb } from '@kaki/db';
import { appendAgentReply, getMessage } from '@kaki/inbox';
import { route, type LlmGateway } from '@kaki/llm-gateway';

/**
 * One visitor turn (ADR-008, ADR-009). Walking skeleton: no triage, retrieval, slot
 * rendering or verifier; the reply is whatever `llm-gateway` returns (the fake
 * provider echoes). FEAT-022 replaces the body with the grounded, verified pipeline;
 * the send gate (ADR-013) arrives with the kill switch and takeover features.
 *
 * Runs in the visitor trust zone: the database role can read only what a visitor
 * conversation may see.
 */
export async function runVisitorTurn(
  deps: { zdb: ZoneDb; llm: LlmGateway },
  job: { tenantId: string; conversationId: string; messageId: string },
) {
  return withTenant(deps.zdb, job.tenantId, async (tx) => {
    const visitorMessage = await getMessage(tx, job.tenantId, job.messageId);
    if (!visitorMessage || visitorMessage.author !== 'visitor') return null;

    const result = await deps.llm.generate({
      model: route('reply'),
      system: 'You are a helpful assistant for a small business.',
      messages: [{ role: 'user', content: visitorMessage.body }],
      maxTokens: 1024,
      meta: { tenantId: job.tenantId, conversationId: job.conversationId },
    });

    return appendAgentReply(tx, {
      tenantId: job.tenantId,
      conversationId: job.conversationId,
      inReplyTo: visitorMessage.id,
      text: result.text,
    });
  });
}
