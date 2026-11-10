import type { ConversationSummary } from '@kaki/contracts';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  CHANNEL_LABEL,
  escalationText,
  initials,
  ownerText,
  PARTY_LABEL,
  rowTime,
} from '../lib/inbox.ts';
import { FlaggedChip, StateChip, UrgentChip, VisitorAvatar } from './conversation-parts.tsx';

/** A conversation row (SCR-APP-014), shared by the list and the search results (FEAT-046). */
export function Row({
  c,
  qs,
  selected,
  meId,
  now,
  preview,
  linkState,
  onOpen,
}: {
  c: ConversationSummary;
  qs: string;
  selected: boolean;
  meId: string | null;
  now: Date;
  /** In place of the last message (search: the author and the marked excerpt). */
  preview?: ReactNode;
  linkState?: unknown;
  onOpen?: () => void;
}) {
  const owner = c.owner ? ownerText(c.owner, meId) : null;
  const escalation = escalationText(c, meId, now);
  return (
    <li data-testid="conversation-row" data-id={c.id}>
      <Link
        to={`/inbox/${c.id}${qs}`}
        className="conversation-row"
        aria-current={selected ? 'true' : undefined}
        state={linkState}
        onClick={onOpen}
      >
        <VisitorAvatar label={PARTY_LABEL[c.channel]} channel={c.channel} />
        <span className="conversation-row__main">
          <span className="conversation-row__title">
            {PARTY_LABEL[c.channel]}
            {c.channel !== 'widget' && (
              <span className="sr-only"> · {CHANNEL_LABEL[c.channel]}</span>
            )}
          </span>
          {c.subject && (
            <span className="conversation-row__subject" data-testid="conversation-subject">
              {c.subject}
            </span>
          )}
          {preview ?? (
            <span className="conversation-row__preview" data-testid="conversation-preview">
              {c.lastMessage ?? 'No messages yet'}
            </span>
          )}
          {owner && (
            <span className="conversation-row__owner" data-testid="conversation-owner">
              <span className="avatar avatar--xs" aria-hidden="true">
                {initials(owner).slice(0, 1)}
              </span>
              <span className="sr-only">Handled by </span>
              {owner}
            </span>
          )}
          {escalation && (
            <span className="conversation-row__owner" data-testid="conversation-escalation">
              <span className="sr-only">Escalated: </span>
              {escalation}
            </span>
          )}
        </span>
        <span className="conversation-row__meta">
          <time dateTime={c.lastMessageAt}>{rowTime(c.lastMessageAt)}</time>
          <span className="conversation-row__chips">
            {c.flaggedAt && <FlaggedChip />}
            <StateChip status={c.status} />
            {c.escalation?.urgent && <UrgentChip />}
          </span>
        </span>
      </Link>
    </li>
  );
}
