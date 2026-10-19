import { withTenant, type ZoneDb } from '@kaki/db';
import { audit } from '@kaki/governance';
import {
  appendAgentReply,
  getMessage,
  hasAssistantMessage,
  recentMessages,
  replyExists,
} from '@kaki/inbox';
import { searchVisitorFacts, visitorKb, type VisitorFact } from '@kaki/kb';
import type { LlmGateway } from '@kaki/llm-gateway';
import { composeReply, type ComposeOutcome, type ComposeResult } from './compose.js';
import { aiAllowed } from './gate.js';
import { HISTORY_LIMIT } from './prompt.js';
import { texts } from './texts.js';

export interface TurnDeps {
  /** The visitor trust zone (ADR-009): it can read only what a visitor conversation may see. */
  zdb: ZoneDb;
  llm: LlmGateway;
  /** Releases a verified segment to the conversation's realtime channel. */
  publishSegment?: (segment: { turnId: string; seq: number; text: string }) => Promise<void>;
}

export interface TurnJobInput {
  tenantId: string;
  conversationId: string;
  messageId: string;
}

export type TurnOutcome = ComposeOutcome | 'paused';

type Stored = NonNullable<Awaited<ReturnType<typeof appendAgentReply>>>;

export type TurnResult = Stored & {
  outcome: TurnOutcome;
  timings: ComposeResult['timings'] | null;
};

/**
 * One visitor turn (UC-20; ADR-008, ADR-009, ADR-013): gate → `lookup_kb` → verified
 * reply → store with fact IDs and disclosure. No transaction is held while the model
 * streams (D8). Idempotent: a turn whose visitor message already has a reply does
 * nothing, and the unique `in_reply_to` index settles a race.
 */
export async function runVisitorTurn(
  deps: TurnDeps,
  job: TurnJobInput,
): Promise<TurnResult | null> {
  const { zdb, llm } = deps;
  const { tenantId, conversationId } = job;

  const prep = await withTenant(zdb, tenantId, async (tx) => {
    const message = await getMessage(tx, tenantId, job.messageId);
    if (!message || message.author !== 'visitor') return null;
    if (await replyExists(tx, tenantId, message.id)) return null;
    const gate = await aiAllowed(tx, tenantId, conversationId);
    const history = await recentMessages(tx, {
      tenantId,
      conversationId,
      upToSeq: message.seq,
      limit: HISTORY_LIMIT,
    });
    const disclosed = await hasAssistantMessage(tx, tenantId, conversationId);
    return { message, gate, history, disclosed };
  });
  if (!prep) return null;
  const { message, gate } = prep;
  const businessName = gate.tenant?.businessName ?? '';
  const disclosure = prep.disclosed ? null : texts.disclosure(businessName);

  async function store(
    outcome: TurnOutcome,
    author: 'agent' | 'system',
    text: string,
    composed: ComposeResult | null,
  ): Promise<TurnResult | null> {
    const stored = await withTenant(zdb, tenantId, async (tx) => {
      const reply = await appendAgentReply(tx, {
        tenantId,
        conversationId,
        inReplyTo: message.id,
        text,
        author,
        factIds: composed?.factIds ?? [],
        disclosure,
      });
      if (!reply) return null;
      const entry = (action: string) =>
        audit.append(tx, tenantId, {
          action,
          actorType: 'agent',
          subjectType: 'message',
          subjectId: reply.message.id,
        });
      // Guardrail results (ADR-008 decision 5, GOV-01): IDs only, no message text.
      for (let i = 0; i < (composed?.violations.length ?? 0); i++)
        await entry('guardrail.segment_blocked');
      if (outcome === 'escalated') await entry('guardrail.escalated');
      if (outcome === 'unavailable' || outcome === 'paused') await entry('agent.fallback_sent');
      return reply;
    });
    return stored ? { ...stored, outcome, timings: composed?.timings ?? null } : null;
  }

  if (!gate.open) {
    // UC-20 5e. Paused: the visitor gets the fallback (architecture §6.5). A human
    // owner or a closed conversation: the AI says nothing.
    return gate.reason === 'paused' ? store('paused', 'system', texts.fallback, null) : null;
  }

  let facts: VisitorFact[];
  try {
    const { vectors } = await llm.embed({
      texts: [message.body],
      purpose: 'query',
      meta: { tenantId },
    });
    facts = await withTenant(zdb, tenantId, async (tx) => {
      const found = await searchVisitorFacts(visitorKb(tx, tenantId, conversationId), vectors[0]!);
      await audit.append(tx, tenantId, {
        action: 'tool.lookup_kb',
        actorType: 'agent',
        subjectType: 'conversation',
        subjectId: conversationId,
      });
      return found;
    });
  } catch {
    // NFR-04: no embedder, no grounded answer. The fallback closes the turn (D6).
    return store('unavailable', 'system', texts.fallback, null);
  }

  const history = prep.history.map((m) => ({
    role: m.author === 'visitor' ? ('user' as const) : ('assistant' as const),
    content: m.body,
  }));
  const composed = await composeReply(
    {
      facts,
      history,
      businessName,
      gstRegistered: gate.tenant.gstRegistered,
      meta: { tenantId, conversationId },
    },
    {
      llm,
      gateOpen: async () =>
        (await withTenant(zdb, tenantId, (tx) => aiAllowed(tx, tenantId, conversationId))).open,
      publish: async (s) => deps.publishSegment?.({ turnId: message.id, ...s }),
    },
  );

  switch (composed.outcome) {
    case 'answered':
    case 'escalated':
      return store(composed.outcome, 'agent', composed.text, composed);
    case 'unavailable':
      return composed.text
        ? store('unavailable', 'agent', `${composed.text} ${texts.fallback}`, composed)
        : store('unavailable', 'system', texts.fallback, composed);
    case 'gate_closed': {
      const now = await withTenant(zdb, tenantId, (tx) => aiAllowed(tx, tenantId, conversationId));
      const paused = !now.open && now.reason === 'paused';
      if (paused)
        return store(
          'paused',
          composed.text ? 'agent' : 'system',
          [composed.text, texts.fallback].filter(Boolean).join(' '),
          composed,
        );
      return composed.text ? store('gate_closed', 'agent', composed.text, composed) : null;
    }
  }
}
