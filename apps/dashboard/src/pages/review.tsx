import type { FactRef, FactType, ReviewFact } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, NavLink } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import {
  approveAllLabel,
  GROUPS,
  gstUnknown,
  plural,
  skipMessage,
  useReviewSummary,
} from '../lib/review.ts';
import { POLL_MS, useVisible } from '../lib/sources.ts';
import { DoneRow, FactCard, type CardGst, type Decided } from './review-card.tsx';
import { ApproveAllDialog, EditApproveDialog } from './review-dialogs.tsx';

interface Done {
  decided: Decided;
  ref: FactRef;
}
interface Toast {
  message: string;
  undo?: FactRef[];
}

/** The Review hub tabs (FEAT-013 ui-design cross-screen): route links, like Knowledge's. */
export function ReviewTabs({ count }: { count?: number }) {
  return (
    <nav className="tabs knowledge-tabs" aria-label="Review">
      <NavLink to="/review" end className="tabs__tab">
        Facts
        {count ? (
          <span className="count-pill count-pill--warning">
            {count}
            <span className="sr-only"> to review</span>
          </span>
        ) : null}
      </NavLink>
      <NavLink to="/review/conflicts" className="tabs__tab">
        Conflicts
      </NavLink>
      <NavLink to="/review/corrections" className="tabs__tab">
        Corrections
      </NavLink>
    </nav>
  );
}

/** design.md `toast` with one Undo action: 5 s, paused while hovered or focused. */
function ReviewToast({
  toast,
  onClose,
  onUndo,
}: {
  toast: Toast | null;
  onClose: () => void;
  onUndo: (refs: FactRef[]) => void;
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
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{toast.message}</span>
      {toast.undo && toast.undo.length > 0 && (
        <Button variant="ghost" className="kaki-btn--sm" onClick={() => onUndo(toast.undo!)}>
          Undo
        </Button>
      )}
    </div>
  );
}

const FAILED = "We couldn't save this just now. Nothing was changed.";

/**
 * The review queue (SCR-APP-019 body, reused by SCR-APP-008; FEAT-013 ui-design): filters,
 * Approve all, the bulk bar, the fact cards grouped in the KB-16 order, the dialogs, the
 * toast and the keyboard shortcuts.
 */
export function ReviewQueue({ setup = false }: { setup?: boolean }) {
  const queryClient = useQueryClient();
  const visible = useVisible();
  const summary = useReviewSummary();
  const busySources = (summary.data?.sourcesBusy ?? 0) > 0;
  const [sourceId, setSourceId] = useState('');
  const [type, setType] = useState<FactType | ''>('');
  const scope = { sourceId: sourceId || undefined, type: type || undefined };
  const filtered = Boolean(sourceId || type);
  const list = useInfiniteQuery({
    queryKey: ['review', sourceId, type],
    queryFn: ({ pageParam }) => api.reviewFacts({ ...scope, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: visible && busySources ? POLL_MS : false,
  });
  const facts = list.data?.pages.flatMap((p) => p.facts) ?? [];

  const [done, setDone] = useState<ReadonlyMap<string, Done>>(new Map());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlyMap<string, 'approve' | 'reject'>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [gst, setGst] = useState<ReadonlyMap<string, CardGst>>(new Map());
  const [gstErrors, setGstErrors] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [editing, setEditing] = useState<ReviewFact | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const queueRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const with_ = <K, V>(m: ReadonlyMap<K, V>, k: K, v: V | null) => {
    const next = new Map(m);
    if (v === null) next.delete(k);
    else next.set(k, v);
    return next;
  };
  const without = <K,>(s: ReadonlySet<K>, ks: K[]) => {
    const next = new Set(s);
    for (const k of ks) next.delete(k);
    return next;
  };
  const refreshCounts = () => queryClient.invalidateQueries({ queryKey: ['review-summary'] });
  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: ['review'] });
    await refreshCounts();
  };

  function markDone(refs: FactRef[], decided: Decided) {
    setDone((d) => {
      const next = new Map(d);
      for (const ref of refs) next.set(ref.id, { decided, ref });
      return next;
    });
    setSelected((s) =>
      without(
        s,
        refs.map((r) => r.id),
      ),
    );
    void refreshCounts();
  }

  async function decide(fact: ReviewFact, kind: 'approve' | 'reject') {
    if (busy.has(fact.id)) return;
    const choice = gst.get(fact.id);
    if (kind === 'approve' && gstUnknown(fact) && !choice) {
      setGstErrors((s) => new Set(s).add(fact.id));
      document.getElementById(`gst-${fact.id}`)?.querySelector('input')?.focus();
      return;
    }
    setBusy((b) => with_(b, fact.id, kind));
    setErrors((e) => with_(e, fact.id, null));
    try {
      const { fact: saved } =
        kind === 'approve'
          ? await api.approveFact(fact.id, {
              version: fact.version,
              ...(choice && gstUnknown(fact) ? { gstTreatment: choice } : {}),
            })
          : await api.rejectFact(fact.id, fact.version);
      const ref = { id: saved.id, version: saved.version };
      markDone([ref], kind === 'approve' ? 'approved' : 'rejected');
      setToast({
        message:
          kind === 'approve'
            ? 'Approved. Your assistant uses it from now on.'
            : "Rejected. Your assistant won't use it.",
        undo: [ref],
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setToast({ message: 'This fact changed since you loaded it.' });
        await refreshAll();
      } else setErrors((e) => with_(e, fact.id, FAILED));
    } finally {
      setBusy((b) => with_(b, fact.id, null));
    }
  }

  async function undo(refs: FactRef[]) {
    setUndoing(true);
    try {
      const res = await api.undoReview(refs);
      setDone((d) => {
        const next = new Map(d);
        for (const r of refs) next.delete(r.id);
        return next;
      });
      setToast({
        message: res.restored
          ? 'Back in review.'
          : "This can't be undone any more; the fact changed since.",
      });
    } catch {
      setToast({ message: "We couldn't undo that just now." });
    } finally {
      setUndoing(false);
      await refreshAll();
    }
  }

  async function decideSelected(kind: 'approve' | 'reject') {
    const refs = facts
      .filter((f) => selected.has(f.id) && !done.has(f.id))
      .map((f) => ({ id: f.id, version: f.version }));
    if (!refs.length) return;
    setBulkBusy(true);
    try {
      if (kind === 'approve') {
        const res = await api.approveSelected(refs);
        markDone(res.approved, 'approved');
        const n = res.approved.length;
        setToast({
          message: [n ? `${plural(n, 'fact')} approved.` : '', skipMessage(res.skipped)]
            .filter(Boolean)
            .join(' '),
          undo: res.approved,
        });
        if (res.skipped.some((s) => s.reason === 'changed' || s.reason === 'not_found'))
          await queryClient.invalidateQueries({ queryKey: ['review'] });
      } else {
        const res = await api.rejectSelected(refs);
        markDone(res.rejected, 'rejected');
        const n = res.rejected.length;
        setToast({
          message: [n ? `${plural(n, 'fact')} rejected.` : '', skipMessage(res.skipped)]
            .filter(Boolean)
            .join(' '),
          undo: res.rejected,
        });
      }
    } catch {
      setToast({ message: FAILED });
    } finally {
      setBulkBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, select, textarea, [role="dialog"], [role="alertdialog"]')) return;
    const key = e.key.toLowerCase();
    if (!['j', 'k', 'a', 'e', 'r'].includes(key)) return;
    const cards = [...(queueRef.current?.querySelectorAll<HTMLElement>('[data-fact-id]') ?? [])];
    const card = target.closest<HTMLElement>('[data-fact-id]');
    if (key === 'j' || key === 'k') {
      e.preventDefault();
      const i = card ? cards.indexOf(card) : -1;
      const next = key === 'j' ? (cards[i + 1] ?? cards[i]) : cards[Math.max(i - 1, 0)];
      (next ?? cards[0])?.focus();
      return;
    }
    const fact = card && facts.find((f) => f.id === card.dataset.factId);
    if (!fact || done.has(fact.id) || fact.status === 'conflicted') return;
    e.preventDefault();
    if (key === 'a') void decide(fact, 'approve');
    if (key === 'r') void decide(fact, 'reject');
    if (key === 'e') setEditing(fact);
  }

  const forbidden = list.error instanceof ApiError && list.error.status === 403;
  if (forbidden)
    return (
      <EmptyState title="You can't review facts">
        Only the Owner or an Admin can approve facts.
      </EmptyState>
    );

  const pending = facts.filter((f) => !done.has(f.id));
  const selectable = pending.filter((f) => f.status !== 'conflicted');
  const selectedCount = selectable.filter((f) => selected.has(f.id)).length;
  const empty = list.isSuccess && facts.length === 0;
  const sourceName = summary.data?.bySource.find((s) => s.id === sourceId)?.name ?? null;
  const approvable = (summary.data?.needsReview ?? 0) > 0;
  const groups = GROUPS.map((g) => ({
    ...g,
    facts: facts.filter((f) => f.type === g.type),
  })).filter((g) => g.facts.length > 0);

  return (
    <div className="review-queue" ref={queueRef} onKeyDown={onKeyDown}>
      {!setup && (
        <div className="page-header">
          <div className="page-header__text">
            <h1 className="page-title" ref={headingRef} tabIndex={-1}>
              Review
            </h1>
            <p className="page-lede">
              Your assistant only uses facts you approve. Prices, policies and promotions are listed
              first.
            </p>
          </div>
          {approvable && !empty && (
            <Button variant="secondary" onClick={() => setApprovingAll(true)}>
              {approveAllLabel(scope, sourceName)}
            </Button>
          )}
        </div>
      )}
      {!setup && (
        <ReviewTabs count={summary.data && summary.data.needsReview + summary.data.conflicted} />
      )}
      {setup && approvable && !empty && (
        <div className="review-queue__setup-actions">
          <Button variant="secondary" onClick={() => setApprovingAll(true)}>
            {approveAllLabel(scope, sourceName)}
          </Button>
        </div>
      )}

      {busySources && (
        <div className="alert alert--info" role="status">
          <p>
            We're still reading {plural(summary.data!.sourcesBusy, 'source')}. More facts appear
            here when it's done.
          </p>
        </div>
      )}

      {(!empty || filtered) && !list.isError && (
        <div className="filters review-filters">
          <label className="field field--inline">
            <span className="sr-only">Source</span>
            <select
              className="input"
              value={sourceId}
              onChange={(e) => {
                setSourceId(e.target.value);
                setSelected(new Set());
              }}
            >
              <option value="">All sources</option>
              {summary.data?.bySource
                .filter((s) => s.id)
                .map((s) => (
                  <option key={s.id} value={s.id!}>
                    {s.name} ({s.count})
                  </option>
                ))}
            </select>
          </label>
          <label className="field field--inline">
            <span className="sr-only">Fact type</span>
            <select
              className="input"
              value={type}
              onChange={(e) => {
                setType(e.target.value as FactType | '');
                setSelected(new Set());
              }}
            >
              <option value="">All types</option>
              {GROUPS.map((g) => (
                <option key={g.type} value={g.type}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <span className="review-filters__hint">
            Keys: <kbd>A</kbd> approve · <kbd>E</kbd> edit · <kbd>R</kbd> reject · <kbd>J</kbd>/
            <kbd>K</kbd> move
          </span>
        </div>
      )}

      {selectedCount > 0 && (
        <div className="bulkbar" data-testid="bulkbar">
          <input
            type="checkbox"
            className="checkbox"
            aria-label="Select all shown"
            checked={selectedCount === selectable.length}
            ref={(el) => {
              if (el) el.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
            }}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(selectable.map((f) => f.id)) : new Set())
            }
          />
          <span className="bulkbar__label">
            <b>{selectedCount} selected</b> of {selectable.length} shown
          </span>
          <Button
            className="kaki-btn--sm"
            onClick={() => void decideSelected('approve')}
            disabled={bulkBusy}
            aria-busy={bulkBusy || undefined}
          >
            Approve {selectedCount}
          </Button>
          <Button
            variant="ghost"
            className="kaki-btn--sm"
            onClick={() => void decideSelected('reject')}
            disabled={bulkBusy}
          >
            Reject
          </Button>
          <Button variant="ghost" className="kaki-btn--sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {list.isPending && (
        <div className="review-groups" aria-busy="true" aria-label="Loading facts">
          {[0, 1].map((i) => (
            <div key={i} className="card review-skeleton">
              <div className="skeleton-field review-skeleton__badge" />
              <div className="skeleton-field review-skeleton__title" />
              <div className="skeleton-field review-skeleton__passage" />
              <div className="skeleton-field review-skeleton__actions" />
            </div>
          ))}
        </div>
      )}

      {list.isError && facts.length === 0 && (
        <ErrorState
          title="We couldn't load your facts"
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        >
          Nothing you approved was lost.
        </ErrorState>
      )}

      {empty && !filtered && (
        <EmptyState
          title={setup ? 'All your facts are reviewed' : 'No facts waiting for review'}
          action={
            setup ? undefined : (
              <Button asChild>
                <Link to="/knowledge/sources/new">Add a source</Link>
              </Button>
            )
          }
        >
          {`New facts show up here after a source finishes reading. Your assistant is using ${plural(summary.data?.approvedInUse ?? 0, 'approved fact')}.`}
        </EmptyState>
      )}
      {empty && filtered && (
        <EmptyState
          title="No facts to review here"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSourceId('');
                setType('');
              }}
            >
              Show all facts
            </Button>
          }
        />
      )}

      {groups.length > 0 && (
        <div className="review-groups">
          {groups.map((g) => (
            <section className="review-group" key={g.type} aria-labelledby={`group-${g.type}`}>
              <div className="review-group__head">
                <h2 id={`group-${g.type}`} className="section-title">
                  {g.label}
                </h2>
                <span className="count-pill count-pill--neutral">
                  {!sourceId && summary.data ? summary.data.byType[g.type] : g.facts.length}
                </span>
              </div>
              {g.facts.map((f) => {
                const d = done.get(f.id);
                return d ? (
                  <DoneRow
                    key={f.id}
                    fact={f}
                    decided={d.decided}
                    undoing={undoing}
                    onUndo={() => void undo([d.ref])}
                  />
                ) : (
                  <FactCard
                    key={f.id}
                    fact={f}
                    selected={selected.has(f.id)}
                    onSelect={(on) =>
                      setSelected((s) => (on ? new Set(s).add(f.id) : without(s, [f.id])))
                    }
                    busy={busy.get(f.id) ?? null}
                    error={errors.get(f.id) ?? null}
                    gst={gst.get(f.id)}
                    gstError={gstErrors.has(f.id)}
                    onGst={(choice) => {
                      setGst((m) => with_(m, f.id, choice));
                      setGstErrors((s) => without(s, [f.id]));
                    }}
                    onApprove={() => void decide(f, 'approve')}
                    onReject={() => void decide(f, 'reject')}
                    onEdit={() => setEditing(f)}
                  />
                );
              })}
            </section>
          ))}
        </div>
      )}

      {list.hasNextPage && (
        <div className="load-more">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            aria-busy={list.isFetchingNextPage || undefined}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more facts'}
          </Button>
        </div>
      )}

      <ApproveAllDialog
        open={approvingAll}
        scope={scope}
        sourceName={sourceName}
        onClose={() => setApprovingAll(false)}
        onDone={async (refs) => {
          setApprovingAll(false);
          setDone(new Map());
          setSelected(new Set());
          await refreshAll();
          setToast({ message: `${plural(refs.length, 'fact')} approved.`, undo: refs });
          headingRef.current?.focus();
        }}
      />
      <EditApproveDialog
        fact={editing}
        onClose={() => setEditing(null)}
        onReload={() => {
          setEditing(null);
          void refreshAll();
        }}
        onDone={(ref) => {
          setEditing(null);
          markDone([ref], 'approved');
          setToast({ message: 'Approved. Your assistant uses it from now on.', undo: [ref] });
        }}
      />
      <div className="sr-only" aria-live="polite">
        {summary.data ? `${plural(summary.data.needsReview, 'fact')} to review` : ''}
      </div>
      <ReviewToast
        toast={toast}
        onClose={() => setToast(null)}
        onUndo={(refs) => void undo(refs)}
      />
    </div>
  );
}

/** SCR-APP-019 Review · Facts at `/review` (KB-16, UC-15; FEAT-013 ui-design). */
export function ReviewPage() {
  return (
    <div className="review">
      <ReviewQueue />
    </div>
  );
}

/** `/review/conflicts` and `/review/corrections` until FEAT-014 and FEAT-018 build them. */
export function ReviewPlaceholder({ title, feature }: { title: string; feature: string }) {
  const summary = useReviewSummary();
  return (
    <div className="review">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title">Review</h1>
        </div>
      </div>
      <ReviewTabs count={summary.data && summary.data.needsReview + summary.data.conflicted} />
      <EmptyState title={`${title} aren't built yet`}>This tab arrives with {feature}.</EmptyState>
    </div>
  );
}

/**
 * `/setup/review`: SCR-APP-008 (partial), the setup's review step (UC-03, UC-15); FEAT-035
 * adds the wizard frame and FEAT-019 the coverage summary.
 */
export function SetupReviewPage() {
  return (
    <div className="review">
      <p className="page-lede">Step 3 of the setup</p>
      <h1 className="page-title">Review your facts</h1>
      <p className="page-lede">
        Approve what your assistant may tell customers. You can change any fact later in Knowledge.
      </p>
      <ReviewQueue setup />
      <div className="review-setup__footer">
        <Button asChild>
          <Link to="/">Continue</Link>
        </Button>
        <p className="review-setup__caption">Facts you haven't approved stay out of answers.</p>
      </div>
    </div>
  );
}
