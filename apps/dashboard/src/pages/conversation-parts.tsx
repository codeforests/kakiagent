import type {
  ConversationStatus,
  ConversationSummary,
  ConversationThread,
  FactChip,
  LeadScore,
  LeadScoring,
  ThreadEvent,
  ThreadMessage,
} from '@kaki/contracts';
import { scoreLabel } from '../lib/leads.ts';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  CHANNEL_LABEL,
  cardCaption,
  clockTime,
  dockText,
  LEAD_STATUS,
  leadLines,
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
  alert: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v4M12 16h.01',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  'more-horizontal': 'M12 12h.01M19 12h.01M5 12h.01',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  'chevron-down': 'M6 9l6 6 6-6',
  spark: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  // Lead score chips and Export CSV (FEAT-050 ui-design).
  flame:
    'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4',
  snowflake: 'M2 12h20M12 2v20M20 16l-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4',
  minus: 'M5 12h14',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  // Email conversations and the Email channel page (FEAT-036 ui-design).
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  'x-circle': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6',
  check: 'M20 6 9 17l-5-5',
  paperclip:
    'm21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5',
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

/** An urgent escalation (FEAT-044 ui-design SCR-APP-014): text, never colour only. */
export function UrgentChip() {
  return (
    <span className="state-chip state-chip--urgent" data-testid="urgent-chip">
      <Glyph name="alert-triangle" size={12} />
      Urgent
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

export function FactLink({ fact, uses }: { fact: FactChip; uses?: number }) {
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

/** A staff bubble's label: "You" for mine, else the name, else "Team member". */
function authorLabel(m: ThreadMessage, meId: string | null): string {
  if (m.author !== 'staff') return AUTHOR_LABEL[m.author];
  if (m.authorUserId && m.authorUserId === meId) return 'You';
  return m.authorName ?? AUTHOR_LABEL.staff;
}

export function Bubble({
  message,
  facts,
  meId = null,
  match = false,
}: {
  message: ThreadMessage;
  facts: Map<string, FactChip>;
  meId?: string | null;
  /** The message a search result opened at (FEAT-046). */
  match?: boolean;
}) {
  // A staff joined/left notice has no body: a caption row of what the visitor saw (FEAT-043).
  if (message.body === '' && message.notice)
    return (
      <li className="thread-notice" data-testid="thread-notice" data-kind={message.noticeKind}>
        <Glyph name="chat" size={16} />
        <span>Visitor saw: {message.notice}</span>
      </li>
    );
  const side = message.author === 'visitor' ? 'in' : 'out';
  return (
    <li
      className={`thread-item thread-item--${side}`}
      data-author={message.author}
      data-testid="thread-message"
      data-message-id={message.id}
      data-match={match ? 'true' : undefined}
    >
      <div className="bubble-meta">
        <span>{authorLabel(message, meId)}</span>
        <time dateTime={message.createdAt}>{clockTime(message.createdAt)}</time>
      </div>
      <div className={`bubble bubble--${message.author}${match ? ' bubble--match' : ''}`}>
        {message.body}
      </div>
      {message.notice && <p className="bubble-notice">{message.notice}</p>}
      {cardCaption(message.card) && (
        <p className="bubble-notice" data-testid="card-caption">
          {cardCaption(message.card)}
        </p>
      )}
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

/** An email or phone with a copy button that says "Copied" (FEAT-049 ui-design SCR-APP-014). */
const SCORE_TONE = { hot: 'danger', warm: 'warning', cold: 'info' } as const;
const SCORE_GLYPH: Record<LeadScore, GlyphName> = {
  hot: 'flame',
  warm: 'sun',
  cold: 'snowflake',
};

/** Hot / Warm / Cold / Not scored (FEAT-050): an icon and the word, never colour alone. */
export function ScoreChip({ scoring }: { scoring: LeadScoring }) {
  const tone = scoring ? SCORE_TONE[scoring.score] : 'neutral';
  return (
    <span className={`chip chip--${tone}`} data-testid="score-chip">
      <Glyph name={scoring ? SCORE_GLYPH[scoring.score] : 'minus'} size={14} />{' '}
      {scoreLabel(scoring)}
    </span>
  );
}

export function CopyRow({ label, value }: { label: 'email' | 'phone'; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="sidebar-copy">
      <span>{value}</span>
      <button
        type="button"
        className="icon-button"
        aria-label={`Copy ${label}`}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
        onBlur={() => setCopied(false)}
      >
        <Glyph name="copy" />
      </button>
      <span className="sr-only" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </p>
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
  const { contact, channel, intents, facts, lead, approval } = thread.sidebar;
  const earlier = contact.previousConversations;
  return (
    <div className="context-sidebar" data-testid="context-sidebar">
      <Section title="Contact">
        <p className="sidebar-strong">{contact.name ?? contact.label}</p>
        {contact.email && <CopyRow label="email" value={contact.email} />}
        {contact.phone && <CopyRow label="phone" value={contact.phone} />}
        <p>First seen {shortDate(contact.firstSeenAt)}</p>
        <p>
          {earlier === 0
            ? 'First conversation'
            : `${earlier} earlier conversation${earlier === 1 ? '' : 's'}`}
        </p>
        {!contact.contactId && (
          <p className="sidebar-caption">
            Names and contact details appear once the visitor shares them.
          </p>
        )}
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
      {approval && (
        <Section title="Approval">
          <div className="sidebar-lead" data-testid="sidebar-approval">
            <span className="chip chip--pending">Waiting for approval</span>
            <p>Due {clockTime(approval.slaDueAt)}</p>
            <Link to={`/approvals/${approval.id}`}>Open approval</Link>
          </div>
        </Section>
      )}
      <Section title="Lead">
        {lead ? (
          <div className="sidebar-lead" data-testid="sidebar-lead">
            <span className={`chip chip--${LEAD_STATUS[lead.status].tone}`}>
              {LEAD_STATUS[lead.status].label}
            </span>{' '}
            <ScoreChip scoring={lead.scoring} />
            <p>Updated {clockTime(lead.updatedAt)}</p>
            <p>{leadLines(lead).consent}</p>
            <p>{leadLines(lead).offers}</p>
            {leadLines(lead).withdrawn && (
              <p className="consent-withdrawn" data-testid="sidebar-withdrawn">
                <Glyph name="alert" size={14} />
                {leadLines(lead).withdrawn}
              </p>
            )}
            <Link to={`/leads/${lead.id}`}>Open lead</Link>
          </div>
        ) : (
          <p className="sidebar-caption">No details left yet.</p>
        )}
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
