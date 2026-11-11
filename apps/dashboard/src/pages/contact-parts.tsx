import type {
  ContactDetail,
  ContactIdentity,
  ContactMergeEntry,
  ContactSide,
  IdentityKind,
} from '@kaki/contracts';
import { Button, ConfirmDialog, FormDialog } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import {
  consentAfterText,
  consentWarning,
  countText,
  identityLabel,
  leadOutcomeText,
  mergeErrorText,
  mergeRowText,
  searchLine,
  sharedText,
} from '../lib/contacts.ts';
import { CHANNEL_LABEL, dateTime, STATE_LABEL } from '../lib/inbox.ts';
import { CopyRow, Glyph, VerifiedMark, type GlyphName } from './conversation-parts.tsx';
import { ConsentEntry, StatusChip } from './leads-parts.tsx';

/** SCR-APP-016 Contact cards and dialogs (FEAT-039 ui-design). The page state is in `contact.tsx`. */

const KIND_GLYPH: Record<IdentityKind, GlyphName> = {
  email: 'mail',
  phone: 'phone',
  telegram: 'send',
};
const COPY_LABEL = { email: 'email', phone: 'phone', telegram: 'Telegram username' } as const;

/** Verified / Not verified: an icon and the word, never colour alone. */
export function VerifiedChip({ verified }: { verified: boolean }) {
  return verified ? (
    <VerifiedMark />
  ) : (
    <span className="chip chip--neutral verified-chip">
      <Glyph name="circle-dashed" size={14} /> Not verified
    </span>
  );
}

function IdentityRow({ i }: { i: ContactIdentity }) {
  const l = identityLabel(i);
  const copyable = i.kind !== 'telegram' || i.value.startsWith('@');
  return (
    <li className="contact-identity" data-testid="contact-identity" data-verified={i.verified}>
      <span className="contact-identity__icon" aria-hidden="true">
        <Glyph name={KIND_GLYPH[i.kind]} />
      </span>
      <div className="contact-identity__value">
        {copyable ? (
          <CopyRow
            label={COPY_LABEL[i.kind]}
            value={l.value}
            prefix={i.kind === 'telegram' ? 'Telegram' : undefined}
          />
        ) : (
          <p className="sidebar-copy">
            <span>{l.value}</span>
          </p>
        )}
        <p className="contact-caption">
          <VerifiedChip verified={i.verified} /> {l.caption}
        </p>
      </div>
    </li>
  );
}

function Card({
  id,
  title,
  icon,
  children,
  headingRef,
  testId,
}: {
  id: string;
  title: string;
  icon?: GlyphName;
  children: ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  testId?: string;
}) {
  return (
    <section className="card stack" aria-labelledby={`${id}-title`} id={id} data-testid={testId}>
      <h2
        className="section-title contact-card__title"
        id={`${id}-title`}
        tabIndex={-1}
        ref={headingRef}
      >
        {icon && <Glyph name={icon} />}
        {title}
      </h2>
      {children}
    </section>
  );
}

export function IdentifiersCard({ contact }: { contact: ContactDetail }) {
  return (
    <Card id="identifiers" title="How to reach them" testId="contact-identifiers">
      {contact.identities.length === 0 ? (
        <p className="contact-caption">No contact details yet.</p>
      ) : (
        <ul className="contact-list">
          {contact.identities.map((i) => (
            <IdentityRow key={i.id} i={i} />
          ))}
        </ul>
      )}
      <p className="contact-caption">
        We only join contacts automatically when the same verified email or Telegram account shows
        up. Typed details stay separate until you merge them.
      </p>
    </Card>
  );
}

export function ConversationsCard({ contact }: { contact: ContactDetail }) {
  const shown = contact.conversations.length;
  return (
    <Card id="conversations" title="Conversations" testId="contact-conversations">
      {shown === 0 ? (
        <p className="contact-caption">No conversations. They left details on the contact form.</p>
      ) : (
        <ul className="contact-list contact-links">
          {contact.conversations.map((c) => (
            <li key={c.id}>
              <Link to={`/inbox/${c.id}`}>
                {CHANNEL_LABEL[c.channel]} · {dateTime(c.startedAt).split(',')[0]} ·{' '}
                {STATE_LABEL[c.status]}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {contact.conversationCount > shown && shown > 0 && (
        <p className="contact-caption">
          Showing the latest {shown} of {contact.conversationCount}.
        </p>
      )}
    </Card>
  );
}

export function LeadsCard({ contact }: { contact: ContactDetail }) {
  return (
    <Card id="leads" title="Leads" testId="contact-leads">
      {contact.leads.length === 0 ? (
        <p className="contact-caption">No leads yet.</p>
      ) : (
        <ul className="contact-list">
          {contact.leads.map((l) => (
            <li key={l.id} className="contact-lead" data-testid="contact-lead">
              <StatusChip status={l.status} />
              {l.supersededBy && (
                <span className="chip chip--neutral">Merged into another lead</span>
              )}
              <Link to={`/leads/${l.supersededBy ?? l.id}`}>
                {l.need || 'No need given'} · {dateTime(l.createdAt).split(',')[0]}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ConsentCard({ contact }: { contact: ContactDetail }) {
  return (
    <Card id="consent" title="Consent records">
      {contact.consents.length === 0 ? (
        <p className="contact-caption">No consent recorded.</p>
      ) : (
        <ul className="lead-consents" data-testid="contact-consents">
          {contact.consents.map((c) => (
            <ConsentEntry key={c.id} c={c} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function DuplicatesCard({
  contact,
  onReview,
}: {
  contact: ContactDetail;
  onReview: (other: { contactId: string; label: string }, opener: HTMLElement) => void;
}) {
  if (contact.duplicates.length === 0) return null;
  return (
    <Card id="duplicates" title="Possibly the same person" icon="users" testId="contact-duplicates">
      <p>
        These contacts share details with this one. They aren't joined because the details aren't
        verified.
      </p>
      <ul className="contact-list">
        {contact.duplicates.map((d) => (
          <li key={d.contactId} className="contact-duplicate" data-testid="contact-duplicate">
            <div>
              <p className="sidebar-strong">
                <Link to={`/contacts/${d.contactId}`}>{d.label}</Link>
              </p>
              <p className="contact-caption">{sharedText(d.shared)}</p>
            </div>
            {contact.canMerge && (
              <Button
                variant="secondary"
                aria-label={`Review merge with ${d.label}`}
                onClick={(e) => onReview(d, e.currentTarget)}
              >
                Review merge
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function MergesCard({
  contact,
  headingRef,
  onUndo,
}: {
  contact: ContactDetail;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onUndo: (m: ContactMergeEntry, opener: HTMLElement) => void;
}) {
  if (contact.merges.length === 0) return null;
  return (
    <Card
      id="merges"
      title="Merged into this contact"
      icon="git-merge"
      headingRef={headingRef}
      testId="contact-merges"
    >
      <ul className="contact-list">
        {contact.merges.map((m) => (
          <li key={m.mergeId} className="contact-merge" data-testid="contact-merge">
            <p className={m.undoneAt ? 'contact-caption' : undefined}>
              {mergeRowText(m)}
              {m.undoneAt && <> · Undone {dateTime(m.undoneAt).split(',')[0]}</>}
            </p>
            {m.undoBlocked === 'survivor_merged' && !m.undoneAt && (
              <p className="contact-caption">
                This contact was merged into another since. Undo that merge first.
              </p>
            )}
            {contact.canMerge && m.canUndo && !m.undoBlocked && (
              <Button
                variant="ghost"
                className="kaki-btn--sm"
                aria-label={`Undo merge with ${m.otherLabel}`}
                onClick={(e) => onUndo(m, e.currentTarget)}
              >
                <Glyph name="undo-2" /> Undo merge
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** "Find the other contact": debounced search (≥ 2 characters, text in the POST body). */
export function SearchDialog({
  open,
  onOpenChange,
  contactId,
  onChoose,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  onChoose: (other: { contactId: string; label: string }) => void;
  onCloseAutoFocus: (e: Event) => void;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const inputId = useId();
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const reset = () => {
    setText('');
    setQ('');
  };
  const change = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };
  const results = useQuery({
    queryKey: ['contact-search', contactId, q],
    queryFn: () => api.searchContacts(q, contactId),
    enabled: open && q.length >= 2,
    retry: false,
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={change}
      title="Find the other contact"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div className="stack contact-search">
        <div className="field">
          <label className="field__label" htmlFor={inputId}>
            Name, email, phone or Telegram username
          </label>
          <input
            id={inputId}
            className="input"
            type="search"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div aria-live="polite" className="contact-search__results">
          {q.length < 2 ? (
            <p className="contact-caption">Type at least 2 characters.</p>
          ) : results.isPending ? (
            <div aria-busy="true" aria-label="Searching" className="stack">
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </div>
          ) : results.isError ? (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't search. Try again.</p>
            </div>
          ) : results.data.contacts.length === 0 ? (
            <p className="contact-caption">No other contacts match.</p>
          ) : (
            <ul className="contact-list" data-testid="contact-search-results">
              {results.data.contacts.map((r) => (
                <li key={r.contactId}>
                  <button
                    type="button"
                    className="contact-result"
                    aria-labelledby={`r-${r.contactId}`}
                    aria-describedby={`d-${r.contactId}`}
                    onClick={() => {
                      reset();
                      onChoose({ contactId: r.contactId, label: r.label });
                    }}
                  >
                    <span className="contact-result__text">
                      <span className="sidebar-strong" id={`r-${r.contactId}`}>
                        {r.label}
                      </span>
                      <span className="contact-caption" id={`d-${r.contactId}`}>
                        {searchLine(r)}
                      </span>
                    </span>
                    <span className="contact-result__choose" aria-hidden="true">
                      Choose
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="kaki-dialog__actions">
          <Button variant="secondary" onClick={() => change(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </FormDialog>
  );
}

function SideColumn({ title, side }: { title: string; side: ContactSide }) {
  return (
    <div className="merge-side" data-testid="merge-side">
      <h3 className="merge-side__title">
        {title}: {side.label}
      </h3>
      <ul className="contact-list">
        {side.identities.map((i) => (
          <li key={i.id} className="merge-side__identity">
            <span>{i.value}</span> <VerifiedChip verified={i.verified} />
          </li>
        ))}
      </ul>
      <p className="contact-caption">{countText(side.conversationCount, 'conversation')}</p>
      {side.openLead && (
        <p className="contact-caption">Open lead: {side.openLead.need || 'No need given'}</p>
      )}
      <p className="contact-caption">{consentAfterText(side.consent.marketing)}</p>
    </div>
  );
}

/** "Merge {other} into {this}?": the preview, focus on its heading (ui-design SCR-APP-016). */
export function MergePreviewDialog({
  contact,
  other,
  onOpenChange,
  onConfirm,
  busy,
  error,
  onReload,
  onCloseAutoFocus,
}: {
  contact: ContactDetail;
  other: { contactId: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  error: unknown;
  onReload: () => void;
  onCloseAutoFocus: (e: Event) => void;
}) {
  const preview = useQuery({
    queryKey: ['merge-preview', contact.id, other?.contactId],
    queryFn: () => api.mergePreview(contact.id, other!.contactId),
    enabled: other !== null,
    retry: false,
    staleTime: 0,
  });
  const label = other?.label ?? '';
  const failure = error ?? (preview.isError ? preview.error : null);
  const failed = failure ? mergeErrorText(failure, label) : null;
  const p = preview.data;
  const lead = p ? leadOutcomeText(p.after.leadOutcome, p.merge.label) : null;
  const warning = p ? consentWarning(p) : null;
  return (
    <ConfirmDialog
      open={other !== null}
      onOpenChange={onOpenChange}
      title={`Merge ${label} into ${contact.label}?`}
      confirmLabel="Merge"
      busy={busy}
      busyLabel="Merging…"
      onConfirm={onConfirm}
      confirmDisabled={!p || Boolean(failed)}
      focusTitle
      onCloseAutoFocus={onCloseAutoFocus}
      alert={
        failed && (
          <div className="alert alert--danger" role="alert">
            <p>
              {preview.isError && !error ? "We couldn't load the preview. " : ''}
              {failed.text}
            </p>
            {failed.reload && (
              <Button variant="secondary" className="kaki-btn--sm" onClick={onReload}>
                Reload
              </Button>
            )}
          </div>
        )
      }
    >
      {!p ? (
        preview.isPending && other ? (
          <div aria-busy="true" aria-label="Loading the preview" className="stack">
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </div>
        ) : (
          <span />
        )
      ) : (
        <div className="stack merge-preview" data-testid="merge-preview">
          <div className="merge-preview__sides">
            <SideColumn title="Keeps" side={p.keep} />
            <SideColumn title="Merges in" side={p.merge} />
          </div>
          <div className="merge-preview__after">
            <h3 className="merge-side__title">After the merge</h3>
            <p>
              {countText(p.after.identities.length, 'way')} to reach them ·{' '}
              {countText(p.after.conversationCount, 'conversation')}
            </p>
            {lead && <p>{lead}</p>}
            <p>{consentAfterText(p.after.consent.marketing)}</p>
            {warning && (
              <div className="alert alert--warning" data-testid="merge-consent-warning">
                <p>{warning}</p>
              </div>
            )}
          </div>
          <p className="contact-caption">You can undo this from this page.</p>
        </div>
      )}
    </ConfirmDialog>
  );
}

/** "Undo the merge with {other}?" */
export function UndoDialog({
  target,
  intoLabel,
  onOpenChange,
  onConfirm,
  busy,
  alert,
  onCloseAutoFocus,
}: {
  target: { otherLabel: string } | null;
  intoLabel: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  alert: ReactNode;
  onCloseAutoFocus: (e: Event) => void;
}) {
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={`Undo the merge with ${target?.otherLabel ?? ''}?`}
      confirmLabel="Undo merge"
      busy={busy}
      busyLabel="Undoing…"
      onConfirm={onConfirm}
      alert={alert}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <p>
        Their conversations, leads, consent records and contact details go back to{' '}
        {target?.otherLabel ?? intoLabel}. Anything added since the merge stays here.
      </p>
    </ConfirmDialog>
  );
}

/** design.md `toast` with one Undo action: 5 s, paused while hovered or focused. */
export function UndoToast({
  toast,
  onClose,
  onUndo,
}: {
  toast: { message: string; mergeId?: string; otherLabel?: string } | null;
  onClose: () => void;
  onUndo: (mergeId: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!toast || paused) return;
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [toast, paused, onClose]);
  if (!toast) return null;
  return (
    <div
      className="toast review-toast"
      role="status"
      data-testid="contact-toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{toast.message}</span>
      {toast.mergeId && (
        <Button variant="ghost" className="kaki-btn--sm" onClick={() => onUndo(toast.mergeId!)}>
          Undo
        </Button>
      )}
    </div>
  );
}
