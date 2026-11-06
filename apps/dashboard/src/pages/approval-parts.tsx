/**
 * Parts of SCR-APP-018 Approval (FEAT-055 ui-design): the quote preview, the draft editor,
 * the reject dialog, "What they asked", the prices used and the conversation excerpt.
 */
import {
  APPROVAL_LIMITS,
  type ApprovalDetail,
  type ApprovalTerms,
  type ApprovalTotals,
} from '@kaki/contracts';
import { Button, ConfirmDialog, FormDialog } from '@kaki/ui';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  editDraftOf,
  formatSgd,
  GST_TEXT,
  liveTotals,
  newLineKey,
  termsError,
  type EditDraft,
  type EditLine,
  type TermsErrors,
} from '../lib/approvals.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { Bubble } from './conversation-parts.tsx';
import { ErrorSummary } from './privacy-parts.tsx';

/** What the visitor gets: the widget quote card's rows, read-only (SCR-WGT-002). */
export function QuotePreview({ terms, totals }: { terms: ApprovalTerms; totals: ApprovalTotals }) {
  return (
    <div className="quote-preview" role="group" aria-label="What the visitor will get">
      {terms.lines.length > 0 && (
        <ul className="quote-preview__lines">
          {terms.lines.map((l, i) => (
            <li key={i}>
              <span>
                {l.quantity} × {l.label}
              </span>
              <span className="quote-preview__amount">
                {formatSgd(l.quantity * l.unitPriceCents)}
              </span>
              <span className="quote-preview__each">{formatSgd(l.unitPriceCents)} each</span>
            </li>
          ))}
        </ul>
      )}
      {terms.discountPct > 0 && (
        <p className="quote-preview__row">
          <span>{terms.discountPct}% off</span>
          <span className="quote-preview__amount">{formatSgd(-totals.discountCents)}</span>
        </p>
      )}
      {terms.lines.length > 0 && (
        <p className="quote-preview__row quote-preview__total">
          <span>Total</span>
          <span className="quote-preview__amount">{formatSgd(totals.totalCents)}</span>
        </p>
      )}
      {terms.lines.length > 0 && GST_TEXT[totals.gst] && (
        <p className="quote-preview__caption">{GST_TEXT[totals.gst]}</p>
      )}
      {terms.note.trim() && <p className="quote-preview__note">{terms.note}</p>}
    </div>
  );
}

/** "What they asked": only the parts the visitor gave, shown as text. */
export function RequestCard({ a }: { a: ApprovalDetail }) {
  const rows: [string, string][] = [];
  if (a.request.items) rows.push(['Items', a.request.items]);
  if (a.request.quantity) rows.push(['Quantity', a.request.quantity]);
  if (a.request.date) rows.push(['Date', a.request.date]);
  if (a.request.discountPct !== null) rows.push(['Discount', `${a.request.discountPct}%`]);
  return (
    <section className="card approval-section" aria-labelledby="ap-asked">
      <h2 id="ap-asked" className="section-title">
        What they asked
      </h2>
      {rows.length ? (
        <dl className="approval-asked">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="approval-muted">See the conversation for what they asked.</p>
      )}
      {a.status === 'pending' && a.aboveMaxDiscount && a.request.discountPct !== null && (
        <div className="alert alert--warning">
          <p>
            They asked for {a.request.discountPct}%, above your {a.maxDiscountPct}% maximum. You can
            still approve it.
          </p>
        </div>
      )}
    </section>
  );
}

/** The edit form (ui-design SCR-APP-018 edit mode): lines, discount, note, live totals. */
export function DraftEditor({
  a,
  busy,
  onSubmit,
  onCancel,
}: {
  a: ApprovalDetail;
  busy: boolean;
  onSubmit: (terms: ApprovalTerms) => void;
  onCancel: () => void;
}) {
  const [initial] = useState<EditDraft>(() => editDraftOf(a.draft));
  const [draft, setDraft] = useState<EditDraft>(initial);
  const [errors, setErrors] = useState<TermsErrors>({});
  const [focusKey, setFocusKey] = useState(0);
  const [discard, setDiscard] = useState(false);
  const totals = liveTotals(draft, a.draftTotals.gst);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);

  const setLine = (key: string, patch: Partial<EditLine>) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const res = termsError(draft);
    if (!res.ok) {
      setErrors(res.errors);
      setFocusKey((k) => k + 1);
      return;
    }
    setErrors({});
    onSubmit(res.terms);
  }

  return (
    <form className="approval-editor" onSubmit={submit} noValidate aria-label="Edit the quote">
      <ErrorSummary errors={errors} prefix="ap" focusKey={focusKey} />
      <fieldset className="approval-editor__lines" disabled={busy}>
        <legend className="sr-only">Lines</legend>
        {draft.lines.map((l, i) => (
          <div key={l.key} className="approval-line" data-testid="approval-line">
            <Field
              id={`ap-label-${l.key}`}
              label={`Line ${i + 1}`}
              error={errors[`label-${l.key}`]}
            >
              <input
                id={`ap-label-${l.key}`}
                className="input"
                value={l.label}
                maxLength={120}
                onChange={(e) => setLine(l.key, { label: e.target.value })}
                aria-invalid={errors[`label-${l.key}`] ? true : undefined}
                aria-describedby={describedBy(`ap-label-${l.key}`, errors[`label-${l.key}`])}
              />
            </Field>
            <Field id={`ap-quantity-${l.key}`} label="Quantity" error={errors[`quantity-${l.key}`]}>
              <input
                id={`ap-quantity-${l.key}`}
                className="input approval-line__qty"
                inputMode="numeric"
                value={l.quantity}
                onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                aria-invalid={errors[`quantity-${l.key}`] ? true : undefined}
                aria-describedby={describedBy(`ap-quantity-${l.key}`, errors[`quantity-${l.key}`])}
              />
            </Field>
            <Field id={`ap-price-${l.key}`} label="Unit price" error={errors[`price-${l.key}`]}>
              <div className="input-suffix">
                <span className="input-suffix__text" aria-hidden="true">
                  S$
                </span>
                <input
                  id={`ap-price-${l.key}`}
                  className="input approval-line__price"
                  inputMode="decimal"
                  value={l.price}
                  onChange={(e) => setLine(l.key, { price: e.target.value })}
                  aria-invalid={errors[`price-${l.key}`] ? true : undefined}
                  aria-describedby={describedBy(`ap-price-${l.key}`, errors[`price-${l.key}`])}
                />
              </div>
            </Field>
            <Button
              variant="ghost"
              type="button"
              className="approval-line__remove"
              aria-label={`Remove ${l.label.trim() || `line ${i + 1}`}`}
              onClick={() =>
                setDraft((d) => ({ ...d, lines: d.lines.filter((x) => x.key !== l.key) }))
              }
            >
              Remove
            </Button>
          </div>
        ))}
        {draft.lines.length < APPROVAL_LIMITS.lines && (
          <Button
            id="ap-form"
            variant="secondary"
            type="button"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                lines: [
                  ...d.lines,
                  {
                    key: newLineKey(),
                    factId: null,
                    factVersion: null,
                    unit: null,
                    label: '',
                    quantity: '1',
                    price: '',
                  },
                ],
              }))
            }
          >
            Add a line
          </Button>
        )}
        <Field
          id="ap-discount"
          label="Discount"
          error={errors.discount}
          help={`Your maximum is ${a.maxDiscountPct}%`}
        >
          <div className="input-suffix">
            <input
              id="ap-discount"
              className="input approval-line__qty"
              inputMode="numeric"
              value={draft.discount}
              onChange={(e) => setDraft((d) => ({ ...d, discount: e.target.value }))}
              aria-invalid={errors.discount ? true : undefined}
              aria-describedby={describedBy('ap-discount', errors.discount, true)}
            />
            <span className="input-suffix__text">%</span>
          </div>
        </Field>
        <Field
          id="ap-note"
          label="Note to the visitor"
          error={errors.note}
          help={`Sent as you write it, for example a delivery time. ${draft.note.length} of ${APPROVAL_LIMITS.note} characters.`}
        >
          <textarea
            id="ap-note"
            className="input input--area"
            rows={3}
            maxLength={APPROVAL_LIMITS.note}
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            aria-invalid={errors.note ? true : undefined}
            aria-describedby={describedBy('ap-note', errors.note, true)}
          />
        </Field>
      </fieldset>
      <div className="approval-editor__totals" aria-live="polite">
        {totals.discountCents > 0 && <p>Discount {formatSgd(-totals.discountCents)}</p>}
        <p className="approval-editor__total">Total {formatSgd(totals.totalCents)}</p>
      </div>
      <div className="approval-actions">
        <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Sending…' : 'Approve and send'}
        </Button>
        <Button
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => (changed ? setDiscard(true) : onCancel())}
        >
          Cancel
        </Button>
      </div>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title="Discard your changes?"
        confirmLabel="Discard"
        confirmVariant="danger"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setDiscard(false);
          onCancel();
        }}
      >
        Your edits to this quote won't be kept.
      </ConfirmDialog>
    </form>
  );
}

/** Reject (ui-design SCR-APP-018): a required reason only the team sees. */
export function RejectDialog({
  open,
  onOpenChange,
  busy,
  onReject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError('Enter a reason');
      document.getElementById('ap-reason')?.focus();
      return;
    }
    setError(undefined);
    onReject(reason.trim());
  }
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Reject this request?" busy={busy}>
      <form className="fact-form" onSubmit={submit} noValidate>
        <p className="kaki-dialog__body">
          The visitor is told your team couldn't confirm it and will follow up.
        </p>
        <Field id="ap-reason" label="Reason (only your team sees this)" error={error}>
          <textarea
            id="ap-reason"
            className="input input--area"
            rows={3}
            maxLength={APPROVAL_LIMITS.reason}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy('ap-reason', error)}
            readOnly={busy}
          />
        </Field>
        <div className="kaki-dialog__actions">
          <Button variant="ghost" type="button" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Rejecting…' : 'Reject'}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

/** Prices used: each fact snapshot, with "Price changed since" when the fact moved on. */
export function PricesCard({ a }: { a: ApprovalDetail }) {
  return (
    <section className="card approval-section" aria-labelledby="ap-prices">
      <h2 id="ap-prices" className="section-title">
        Prices used
      </h2>
      {a.prices.length === 0 ? (
        <p className="approval-muted">No prices from your facts were used.</p>
      ) : (
        <ul className="approval-prices">
          {a.prices.map((p) => (
            <li key={`${p.factId}-${p.version}`}>
              <span>{p.name}</span>
              <span className="quote-preview__amount">
                {formatSgd(p.priceCents)}
                {p.unit ? ` / ${p.unit}` : ''}
              </span>
              <span className="approval-prices__chips">
                <Link className="chip chip--info" to={`/knowledge/facts/${p.factId}`}>
                  Fact
                  <span className="sr-only">: {p.name}</span>
                </Link>
                {!p.current && <span className="chip chip--warning">Price changed since</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The latest messages up to the request, read-only, and a link to the conversation. */
export function ExcerptCard({ a }: { a: ApprovalDetail }) {
  return (
    <section className="card approval-section" aria-labelledby="ap-conversation">
      <h2 id="ap-conversation" className="section-title">
        Conversation
      </h2>
      <ol className="thread-log approval-excerpt">
        {a.excerpt.map((m) => (
          <Bubble key={m.id} message={m} facts={NO_FACTS} />
        ))}
      </ol>
      <Link to={`/inbox/${a.conversationId}`}>Open conversation</Link>
    </section>
  );
}
const NO_FACTS = new Map();
