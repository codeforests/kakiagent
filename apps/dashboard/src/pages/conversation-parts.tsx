import type {
  ConversationStatus,
  ConversationSummary,
  ConversationThread,
  FactChip,
  ThreadEvent,
  ThreadMessage,
} from '@kaki/contracts';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  CHANNEL_LABEL,
  clockTime,
  dockText,
  eventText,
  initials,
  intentLabel,
  shortDate,
  STATE_ICON,
  STATE_LABEL,
  STATE_TOKEN,
} from '../lib/inbox.ts';

// Lucide-style 24-px strokes for the inbox (design.md §2.4); decorative, labels carry meaning.
const GLYPHS = {
  bot: 'M12 8V4H8M4 12h16v8H4zM2 14h2M20 14h2M9 13v2M15 13v2',
  'alert-triangle':
    'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  'check-circle': 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  'more-horizontal': 'M12 12h.01M19 12h.01M5 12h.01',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  'chevron-down': 'M6 9l6 6 6-6',
} as const;
export type GlyphName = keyof typeof GLYPHS;

export function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={GLYPHS[name]} />
    </svg>
  );
}

export function StateChip({ status }: { status: ConversationStatus }) {
  return (
    <span className={`state-chip state-chip--${STATE_TOKEN[status]}`} data-testid="state-chip">
      <Glyph name={STATE_ICON[status] as GlyphName} size={12} />
      {STATE_LABEL[status]}
    </span>
  );
}

export function FlaggedChip() {
  return (
    <span className="state-chip state-chip--flagged" data-testid="flagged-chip">
      <Glyph name="flag" size={12} />
      Flagged
    </span>
  );
}

/** The visitor's avatar with the channel's badge glyph. */
export function VisitorAvatar({
  label,
  channel,
}: {
  label: string;
  channel: ConversationSummary['channel'];
}) {
  return (
    <span className="visitor-avatar" aria-hidden="true">
      {initials(label)}
      <span className="visitor-avatar__badge" title={CHANNEL_LABEL[channel]}>
        <Glyph name="chat" size={10} />
      </span>
    </span>
  );
}

const FACT_STATUS_TEXT: Partial<Record<FactChip['status'], string>> = {
  disabled: 'disabled',
  rejected: 'rejected',
  conflicted: 'in conflict',
  needs_review: 'needs review',
};

function FactLink({ fact, uses }: { fact: FactChip; uses?: number }) {
  const status = FACT_STATUS_TEXT[fact.status];
  return (
    <Link className="fact-chip" to={`/knowledge/facts/${fact.id}`} data-testid="fact-chip">
      {uses === undefined ? `Used: ${fact.label}` : fact.label}
      {status && ` · ${status}`}
      {uses !== undefined && uses > 1 && <span className="fact-chip__uses"> ×{uses}</span>}
    </Link>
  );
}

/** The facts an AI answer used, labelled from the sidebar; a deleted fact shows nothing. */
function FactChips({ ids, facts }: { ids: string[]; facts: Map<string, FactChip> }) {
  const [all, setAll] = useState(false);
  const known = ids.map((id) => facts.get(id)).filter((f): f is FactChip => f !== undefined);
  if (known.length === 0) return null;
  const shown = all ? known : known.slice(0, 3);
  return (
    <ul className="fact-chips" aria-label="Facts used">
      {shown.map((f) => (
        <li key={f.id}>
          <FactLink fact={f} />
        </li>
      ))}
      {!all && known.length > 3 && (
        <li>
          <button type="button" className="fact-chip fact-chip--more" onClick={() => setAll(true)}>
            +{known.length - 3} more
          </button>
        </li>
      )}
    </ul>
  );
}

const AUTHOR_LABEL: Record<ThreadMessage['author'], string> = {
  visitor: 'Website visitor',
  agent: 'Assistant',
  staff: 'Team member',
  system: 'Assistant',
};

export function Bubble({
  message,
  facts,
}: {
  message: ThreadMessage;
  facts: Map<string, FactChip>;
}) {
  const side = message.author === 'visitor' ? 'in' : 'out';
  return (
    <li
      className={`thread-item thread-item--${side}`}
      data-author={message.author}
      data-testid="thread-message"
    >
      <div className="bubble-meta">
        <span>{AUTHOR_LABEL[message.author]}</span>
        <time dateTime={message.createdAt}>{clockTime(message.createdAt)}</time>
      </div>
      <div className={`bubble bubble--${message.author}`}>{message.body}</div>
      {message.notice && <p className="bubble-notice">{message.notice}</p>}
      {message.author === 'agent' && <FactChips ids={message.factIds} facts={facts} />}
    </li>
  );
}

export function Divider({ event }: { event: ThreadEvent }) {
  return (
    <li className="thread-divider" data-testid="thread-divider">
      <span>
        {eventText(event)} · <time dateTime={event.at}>{clockTime(event.at)}</time>
      </span>
    </li>
  );
}

export function Dock({ conversation }: { conversation: ConversationSummary }) {
  return (
    <div className="thread-dock" data-testid="thread-dock">
      <Glyph name={STATE_ICON[conversation.status] as GlyphName} />
      <p>{dockText(conversation)}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="sidebar-section" open>
      <summary>
        <h3>{title}</h3>
        <Glyph name="chevron-down" />
      </summary>
      <div className="sidebar-section__body">{children}</div>
    </details>
  );
}

/** INB-04's context: contact, channel, intents, lead and the facts used (SCR-APP-015). */
export function ContextSidebar({ thread }: { thread: ConversationThread }) {
  const { contact, channel, intents, facts } = thread.sidebar;
  const earlier = contact.previousConversations;
  return (
    <div className="context-sidebar" data-testid="context-sidebar">
      <Section title="Contact">
        <p className="sidebar-strong">{contact.label}</p>
        <p>First seen {shortDate(contact.firstSeenAt)}</p>
        <p>
          {earlier === 0
            ? 'First conversation'
            : `${earlier} earlier conversation${earlier === 1 ? '' : 's'}`}
        </p>
        <p className="sidebar-caption">
          Names and contact details appear once the visitor shares them.
        </p>
      </Section>
      <Section title="Channel">
        <p>{CHANNEL_LABEL[channel]}</p>
      </Section>
      <Section title="Intent">
        {intents.length === 0 ? (
          <p className="sidebar-caption">No signals yet.</p>
        ) : (
          <ul className="sidebar-list" data-testid="intent-list">
            {intents.map((i) => (
              <li key={i.signal}>
                {intentLabel(i.signal)}
                {i.count > 1 && ` (${i.count})`}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Lead">
        <p className="sidebar-caption">No lead yet.</p>
      </Section>
      <Section title="Facts used">
        {facts.length === 0 ? (
          <p className="sidebar-caption">
            The assistant hasn't used any facts in this conversation yet.
          </p>
        ) : (
          <ul className="fact-chips fact-chips--stack">
            {facts.map((f) => (
              <li key={f.id}>
                <FactLink fact={f} uses={f.uses} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
