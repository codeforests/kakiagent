import {
  CorrectionSource,
  DEFAULT_REVIEW_INTERVALS,
  type CorrectionItem,
  type ReviewIntervals,
} from '@kaki/contracts';
import { Button, EmptyState, ErrorState, FormDialog } from '@kaki/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { relativeTime } from '../lib/coach.ts';
import {
  decisionLabel,
  effectiveChange,
  fixSummary,
  INTERVAL_FIELDS,
  intervalError,
  SOURCE_LABEL,
  sourceTone,
  useCorrectionsChanged,
} from '../lib/corrections.ts';
import { Field } from '../lib/field.tsx';
import { describedBy, useToast } from '../lib/form.ts';
import { useReviewSummary } from '../lib/review.ts';
import { ReviewTabs } from './review.tsx';

export function CorrectionsForbidden() {
  return (
    <EmptyState title="You can't work the correction queue">
      Only the Owner and Admins can work the correction queue.
    </EmptyState>
  );
}

/**
 * `/review/corrections`: SCR-APP-021 Review · Corrections (KB-18, KB-17, UC-16; FEAT-018
 * ui-design). Open or closed items, newest first, filtered by source in the query string.
 */
export function CorrectionsPage() {
  const [search, setSearch] = useSearchParams();
  const status = search.get('status') === 'closed' ? 'closed' : 'open';
  const parsed = CorrectionSource.safeParse(search.get('source'));
  const source = parsed.success ? parsed.data : undefined;
  const summary = useReviewSummary();
  const [toast, setToast] = useToast();
  const changed = useCorrectionsChanged();

  const setFilter = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSearch(next, { replace: true });
  };

  const list = useInfiniteQuery({
    queryKey: ['corrections', status, source ?? ''],
    queryFn: ({ pageParam }) => api.corrections({ status, source, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.corrections) ?? [];
  const forbidden = list.error instanceof ApiError && list.error.status === 403;

  return (
    <div className="review">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title">Review</h1>
          <p className="page-lede">
            Signals that something your assistant says may be wrong. Nothing changes until you
            accept a fix.
          </p>
        </div>
        {!forbidden && (
          <Button variant="ghost" onClick={() => setFilter({ intervals: '1' })}>
            Review intervals
          </Button>
        )}
      </div>
      <ReviewTabs
        count={summary.data && summary.data.needsReview + summary.data.conflicted}
        conflicts={summary.data?.conflicts}
        corrections={summary.data?.openCorrections}
      />
      {forbidden ? (
        <CorrectionsForbidden />
      ) : (
        <div className="review-queue">
          <div className="filters corrections-filters">
            <fieldset className="segmented" role="radiogroup" aria-label="Show">
              {(
                [
                  ['open', 'Open'],
                  ['closed', 'Closed'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="segmented__option">
                  <input
                    type="radio"
                    name="corrections-status"
                    checked={status === value}
                    onChange={() => setFilter({ status: value === 'open' ? null : value })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            <label className="field field--inline">
              <span className="sr-only">Source</span>
              <select
                className="input"
                value={source ?? ''}
                onChange={(e) => setFilter({ source: e.target.value || null })}
              >
                <option value="">All sources</option>
                {CorrectionSource.options.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {list.isPending && (
            <ul className="source-list" aria-busy="true" aria-label="Loading corrections">
              {Array.from({ length: 5 }, (_, i) => (
                <li key={i} className="skeleton-row" />
              ))}
            </ul>
          )}
          {list.isError && (
            <ErrorState
              title="Couldn't load corrections."
              action={
                <Button variant="secondary" onClick={() => void list.refetch()}>
                  Try again
                </Button>
              }
            />
          )}
          {list.isSuccess && items.length === 0 && (
            <ListEmpty
              status={status}
              source={source}
              onShowAll={() => setFilter({ source: null })}
            />
          )}
          {items.length > 0 && (
            <ul
              className="source-list"
              aria-label={status === 'open' ? 'Open corrections' : 'Closed corrections'}
            >
              {items.map((c) => (
                <CorrectionRow
                  key={c.id}
                  item={c}
                  onReconfirmed={(label) => {
                    setToast(`Re-confirmed. ${label} stays as it is.`);
                    changed();
                  }}
                />
              ))}
            </ul>
          )}
          {list.hasNextPage && (
            <div className="load-more">
              <Button
                variant="secondary"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
      <IntervalsDialog
        open={search.get('intervals') === '1'}
        onClose={() => setFilter({ intervals: null })}
        onSaved={() => {
          setFilter({ intervals: null });
          setToast('Review intervals saved. The next daily check uses them.');
        }}
      />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function ListEmpty({
  status,
  source,
  onShowAll,
}: {
  status: 'open' | 'closed';
  source: CorrectionSource | undefined;
  onShowAll: () => void;
}) {
  if (source)
    return (
      <EmptyState
        title={`No ${status} items from ${SOURCE_LABEL[source]}.`}
        action={
          <Button variant="secondary" onClick={onShowAll}>
            Show all sources
          </Button>
        }
      />
    );
  if (status === 'closed') return <EmptyState title="No decisions yet." />;
  return (
    <EmptyState title="Nothing to correct" action={<Link to="/coach">Practise in Coach</Link>}>
      Corrections you teach in Coach and facts due for a check appear here.
    </EmptyState>
  );
}

/** A compact `correction-item`: the link, then the stale row's one-tap Re-confirm (KB-17). */
function CorrectionRow({
  item,
  onReconfirmed,
}: {
  item: CorrectionItem;
  onReconfirmed: (label: string) => void;
}) {
  const change = effectiveChange(item);
  const reconfirm = useMutation({
    mutationFn: () => api.acceptCorrection(item.id, null),
    onSuccess: () => onReconfirmed(change.kind === 'reconfirm' ? change.label : ''),
  });
  const stale =
    reconfirm.error instanceof ApiError &&
    reconfirm.error.status === 409 &&
    reconfirm.error.code === 'correction_stale';
  const open = item.status === 'open';
  return (
    <li className="source-row correction-row" data-testid="correction-row">
      <div className="correction-row__main">
        <Link className="correction-row__link" to={`/review/corrections/${item.id}`}>
          {fixSummary(change)}
        </Link>
        <div className="correction-row__chips">
          <span className={`chip chip--${sourceTone(item.source)}`}>
            {SOURCE_LABEL[item.source]}
          </span>
          {!open && <span className="chip chip--neutral">{decisionLabel(item)}</span>}
          {item.facts.map((f) =>
            f.status === 'deleted' ? (
              <span key={f.id} className="chip chip--danger">
                Deleted · {f.label}
              </span>
            ) : (
              <span key={f.id} className="chip chip--info">
                {f.label}
              </span>
            ),
          )}
        </div>
        <span className="source-row__meta">
          {open
            ? relativeTime(item.createdAt)
            : `Decided ${relativeTime(item.decidedAt ?? item.createdAt)}`}
        </span>
      </div>
      {open && item.change.kind === 'reconfirm' && (
        <div className="correction-row__action">
          <Button
            variant="secondary"
            onClick={() => reconfirm.mutate()}
            disabled={reconfirm.isPending}
            aria-busy={reconfirm.isPending || undefined}
            aria-label={`Re-confirm ${item.change.label}`}
          >
            {reconfirm.isPending ? 'Re-confirming…' : 'Re-confirm'}
          </Button>
        </div>
      )}
      {reconfirm.isError && (
        <div className="alert alert--warning" role="alert">
          <p>
            {stale ? 'This fact changed since it was flagged.' : "Couldn't re-confirm this fact."}{' '}
            <Link to={`/review/corrections/${item.id}`}>Open the item</Link>
          </p>
        </div>
      )}
    </li>
  );
}

type IntervalDraft = Record<keyof ReviewIntervals, string>;

const toDraft = (i: ReviewIntervals): IntervalDraft => ({
  product: String(i.product),
  faq: String(i.faq),
  policy: String(i.policy),
  promotion: String(i.promotion),
});

/** The "Review intervals" `form-dialog` (KB-17, D6), opened by `?intervals=1`. */
export function IntervalsDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const intervals = useQuery({
    queryKey: ['review-intervals'],
    queryFn: api.reviewIntervals,
    enabled: open,
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => (o ? undefined : onClose())}
      title="Review intervals"
    >
      {open && intervals.isPending && (
        <div className="kaki-dialog__body" aria-busy="true">
          <div className="skeleton-field" />
        </div>
      )}
      {open && intervals.isError && (
        <div className="alert alert--danger" role="alert">
          <p>Couldn't load your review intervals.</p>
          <Button variant="secondary" onClick={() => void intervals.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {open && intervals.data && (
        <IntervalsForm
          initial={intervals.data.intervals ?? DEFAULT_REVIEW_INTERVALS}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </FormDialog>
  );
}

function IntervalsForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: ReviewIntervals;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<IntervalDraft>(() => toDraft(initial));
  const [submitted, setSubmitted] = useState(false);
  const errors = Object.fromEntries(
    INTERVAL_FIELDS.map(({ type }) => [type, intervalError(draft[type])]),
  ) as Record<keyof ReviewIntervals, string | undefined>;
  const save = useMutation({
    mutationFn: (i: ReviewIntervals) => api.saveReviewIntervals(i),
    onSuccess: (res) => {
      queryClient.setQueryData(['review-intervals'], res);
      onSaved();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (Object.values(errors).some(Boolean)) return;
    save.mutate({
      product: Number(draft.product),
      faq: Number(draft.faq),
      policy: Number(draft.policy),
      promotion: Number(draft.promotion),
    });
  }

  return (
    <form className="fact-form" onSubmit={submit} noValidate>
      <p className="kaki-dialog__body">
        Facts not confirmed within these times are added here to check. They stay in use until you
        act.
      </p>
      {save.isError && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't save this just now. Nothing was changed.</p>
        </div>
      )}
      {INTERVAL_FIELDS.map(({ type, label }) => {
        const id = `interval-${type}`;
        const error = submitted ? errors[type] : undefined;
        return (
          <Field key={type} id={id} label={label} error={error}>
            <div className="input-suffix">
              <input
                id={id}
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={24}
                value={draft[type]}
                onChange={(e) => setDraft((d) => ({ ...d, [type]: e.target.value }))}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy(id, error)}
                readOnly={save.isPending}
              />
              <span className="input-suffix__text">months</span>
            </div>
          </Field>
        );
      })}
      <div className="kaki-dialog__actions">
        <Button variant="ghost" type="button" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending || undefined}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
