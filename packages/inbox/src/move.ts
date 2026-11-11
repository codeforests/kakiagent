import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import type { ConversationRow, MessageRow } from './mappers.js';
import { conversationLanguage } from './ownership.js';

export type MoveTarget = 'telegram' | 'email';

/**
 * Moves a widget conversation to another channel (CHN-07; FEAT-038 §5.5, D2). Compare-and-set
 * on `version` through `conversation_move_channel()`: only `widget → telegram/email`. First the
 * widget's `handoff_moved` notice (with its `moved` card) is stored while the conversation is
 * still on the widget, so the delivery trigger never sends it; then the channel flips, so every
 * later reply (AI or staff) goes out on the new channel. Status and owner are unchanged. Audited
 * `conversation.moved` `{ from: 'widget', to }` (the thread's divider). Null when the
 * conversation isn't on the widget any more, or its version moved.
 */
export async function moveConversation(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    to: MoveTarget;
    notice: (language: 'en' | 'zh') => string;
    card: Record<string, unknown>;
  },
): Promise<{ conversation: ConversationRow; notice: MessageRow } | null> {
  const c = schema.conversations;
  const [current] = await tx
    .select()
    .from(c)
    .where(and(eq(c.tenantId, input.tenantId), eq(c.id, input.conversationId)))
    .for('update');
  if (!current || current.channel !== 'widget') return null;
  const language = await conversationLanguage(tx, input.tenantId, input.conversationId);
  const [notice] = await tx
    .insert(schema.messages)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      author: 'system',
      body: '',
      notice: input.notice(language),
      noticeKind: 'handoff_moved',
      card: input.card,
      language,
    })
    .returning();
  const { rows } = await tx.execute<{ v: number | null }>(
    sql`select conversation_move_channel(${input.conversationId}, ${input.to}, ${current.version}) as v`,
  );
  if (rows[0]?.v == null)
    throw new Error('moveConversation: the conversation changed under its lock');
  await tx
    .update(c)
    .set({ lastMessageAt: notice!.createdAt })
    .where(and(eq(c.tenantId, input.tenantId), eq(c.id, input.conversationId)));
  await audit.append(tx, input.tenantId, {
    action: 'conversation.moved',
    actorType: 'visitor',
    subjectType: 'conversation',
    subjectId: input.conversationId,
    payload: { from: auditCode('widget'), to: auditCode(input.to) },
  });
  const [row] = await tx
    .select()
    .from(c)
    .where(and(eq(c.tenantId, input.tenantId), eq(c.id, input.conversationId)));
  return { conversation: row!, notice: notice! };
}
