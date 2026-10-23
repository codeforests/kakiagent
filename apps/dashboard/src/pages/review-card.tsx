import type { ReviewFact } from '@kaki/contracts';
import { Button } from '@kaki/ui';
import { Link } from 'react-router';
import { factTitle, POLICY_KIND_LABEL, sgd } from '../lib/facts.ts';
import { dayOf, GROUP, gstUnknown, shortUrl, valueLine } from '../lib/review.ts';
import { isImported, provenanceWords } from '../lib/sources.ts';

export type CardGst = 'inclusive' | 'exclusive';
export type Decided = 'approved' | 'rejected';

export interface FactCardProps {
  fact: ReviewFact;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  /** Which action is running on this card, if any. */
  busy: 'approve' | 'reject' | null;
  /** A failed decision on this card (design.md `fact-card` error state). */
  error: string | null;
  gst: CardGst | undefined;
  gstError: boolean;
  onGst: (gst: CardGst) => void;
  onApprove: () => void;
  onEdit: () => void;
  onReject: () => void;
}

function Passage({ fact }: { fact: ReviewFact }) {
  const p = fact.passage;
  if (!p) return null;
  return (
    <blockquote className="passage review-card__passage" cite={fact.provenance?.url}>
      <span data-testid="review-passage">
        {p.before}
        <mark>{p.quote}</mark>
        {p.after}
      </span>
      {fact.sourceCapturedAt && (
        <span className="review-card__caption">
          {fact.provenance?.location ? 'File' : 'Website'} · read {dayOf(fact.sourceCapturedAt)}
        </span>
      )}
    </blockquote>
  );
}

/**
 * design.md `fact-card` (KB-16, UC-15) as bound in FEAT-013 ui-design: the header row,
 * the value, flags, the source passage well, and Approve · Edit and approve · Reject. A
 * conflicted fact only links to its conflict (KB-06; FEAT-014).
 */
export function FactCard(props: FactCardProps) {
  const { fact, selected, busy, error, gst, gstError } = props;
  const title = factTitle(fact);
  const headingId = `review-${fact.id}`;
  const imported = isImported(fact.provenance?.location);
  const confidence =
    fact.confidence === null || imported ? null : Math.round(fact.confidence * 100);
  const conflicted = fact.status === 'conflicted';
  const needsGst = gstUnknown(fact);
  const value = valueLine(fact);
  const working = busy !== null;
  return (
    <article
      className="card review-card"
      aria-labelledby={headingId}
      tabIndex={0}
      data-fact-id={fact.id}
      data-testid="review-card"
      aria-keyshortcuts={conflicted ? undefined : 'A E R J K'}
    >
      {conflicted ? (
        <span />
      ) : (
        <input
          type="checkbox"
          className="checkbox review-card__select"
          checked={selected}
          onChange={(e) => props.onSelect(e.target.checked)}
          aria-label={`Select ${title}`}
          disabled={working}
        />
      )}
      <div className="review-card__body">
        <div className="review-card__meta">
          <span
            className={`status-badge status-badge--${conflicted ? 'conflict' : 'review'}`}
            aria-busy={working || undefined}
          >
            {working ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <span className="status-badge__dot" aria-hidden="true" />
            )}
            {conflicted ? 'Conflicted' : 'Needs review'}
          </span>
          <span className="review-card__kind">
            {GROUP[fact.type].one}
            {fact.type === 'policy' && ` · ${POLICY_KIND_LABEL[fact.value.kind]}`}
            {imported && ' · Imported'}
            {confidence !== null && (
              <>
                {' · '}
                <span className={confidence < 70 ? 'review-card__low' : undefined}>
                  {confidence < 70 && <span aria-hidden="true">! </span>}
                  {confidence}% confidence
                </span>
              </>
            )}
          </span>
          {fact.provenance?.location && (
            // A file has no address to open: the page and the file's name (FEAT-015).
            <span className="review-card__source">
              {provenanceWords(fact.provenance.location, fact.sourceName ?? 'the file')}
            </span>
          )}
          {fact.provenance && !fact.provenance.location && (
            <a
              className="review-card__source"
              href={fact.provenance.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {shortUrl(fact.provenance.url)}
              <span aria-hidden="true"> ↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
        <div className="review-card__value">
          <h3 id={headingId}>{title}</h3>
          {value && (
            <p className={fact.type === 'product' ? 'review-card__price' : 'review-card__text'}>
              {value}
            </p>
          )}
        </div>
        {(needsGst || conflicted) && (
          <div className="review-card__flags">
            {needsGst && <span className="chip chip--warning">GST treatment unknown</span>}
            {conflicted && <span className="chip chip--danger">Conflicts with another source</span>}
          </div>
        )}
        <Passage fact={fact} />
        {needsGst && !conflicted && (
          <fieldset
            className="radio-group review-card__gst"
            id={`gst-${fact.id}`}
            aria-describedby={`gst-${fact.id}-help${gstError ? ` gst-${fact.id}-error` : ''}`}
          >
            <legend className="field__label">Does this price include GST? (required)</legend>
            {(['inclusive', 'exclusive'] as const).map((g) => (
              <label className="radio" key={g}>
                <input
                  type="radio"
                  name={`gst-${fact.id}`}
                  checked={gst === g}
                  onChange={() => props.onGst(g)}
                  disabled={working}
                />
                {g === 'inclusive' ? 'Price includes GST' : 'Price is before GST'}
              </label>
            ))}
            <p className="field__help" id={`gst-${fact.id}-help`}>
              Your assistant won't quote this price until you choose.
            </p>
            {gstError && (
              <p className="field__error" id={`gst-${fact.id}-error`}>
                <span aria-hidden="true">!</span> Choose whether the price includes GST
              </p>
            )}
          </fieldset>
        )}
        {error && (
          <div className="alert alert--danger" role="alert">
            <p>{error}</p>
          </div>
        )}
        <div className="review-card__actions">
          {conflicted ? (
            <Button asChild variant="secondary">
              <Link to="/review/conflicts">Resolve conflict</Link>
            </Button>
          ) : (
            <>
              <Button onClick={props.onApprove} disabled={working} aria-busy={busy === 'approve'}>
                {busy === 'approve' ? 'Approving…' : 'Approve'}
              </Button>
              <Button variant="secondary" onClick={props.onEdit} disabled={working}>
                Edit and approve
              </Button>
              <Button
                variant="ghost"
                onClick={props.onReject}
                disabled={working}
                aria-busy={busy === 'reject'}
              >
                {busy === 'reject' ? 'Rejecting…' : 'Reject'}
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

/** A decided card collapsed to one line, with Undo (design.md `fact-card` approved/rejected). */
export function DoneRow({
  fact,
  decided,
  onUndo,
  undoing,
}: {
  fact: ReviewFact;
  decided: Decided;
  onUndo: (() => void) | null;
  undoing: boolean;
}) {
  const value = fact.type === 'product' ? ` · ${sgd(fact.value.price)}` : '';
  return (
    <article
      className="card review-card review-card--done"
      aria-label={`${factTitle(fact)} ${decided}`}
      data-testid="review-done"
    >
      <span />
      <div className="review-card__done">
        <span
          className={`status-badge status-badge--${decided === 'approved' ? 'approved' : 'rejected'}`}
        >
          <span className="status-badge__dot" aria-hidden="true" />
          {decided === 'approved' ? 'Approved' : 'Rejected'}
        </span>
        <span className="review-card__done-text">
          <b>{factTitle(fact)}</b>
          {value}
        </span>
        {onUndo && (
          <Button
            variant="ghost"
            className="kaki-btn--sm"
            onClick={onUndo}
            disabled={undoing}
            aria-busy={undoing || undefined}
          >
            Undo
          </Button>
        )}
      </div>
    </article>
  );
}
