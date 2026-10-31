import type { ConversationSummary, Message } from '@kaki/contracts';
import type { schema } from '@kaki/db';

export type MessageRow = typeof schema.messages.$inferSelect;
export type NoticeKind = (typeof schema.NOTICE_KINDS)[number];
export type FlagReason = (typeof schema.FLAG_REASONS)[number];
export type ConversationRow = typeof schema.conversations.$inferSelect;

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    author: row.author,
    body: row.body,
    inReplyTo: row.inReplyTo,
    disclosure: row.disclosure,
    notice: row.notice,
    noticeKind: row.noticeKind,
    authorName: row.authorName,
    language: row.language,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A conversation's owner as staff see it (FEAT-043): the API names it with `memberNames`. */
export type SummaryOwner = ConversationSummary['owner'];

export function toSummary(
  row: ConversationRow,
  lastMessage: string | null,
  owner: SummaryOwner = null,
): ConversationSummary {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessage,
    flaggedAt: row.flaggedAt?.toISOString() ?? null,
    flagReasons: row.flagReasons,
    closeReason: row.closeReason,
    closedAt: row.closedAt?.toISOString() ?? null,
    owner,
  };
}
