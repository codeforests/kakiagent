import type {
  Conflict,
  ConflictFact,
  ConflictList,
  Fact,
  ResolveConflictBody,
} from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState, ErrorState, FormDialog } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { createBody, fromFact, validate, type Draft, type FieldName } from '../lib/fact-draft.ts';
import { factTitle, POLICY_KIND_LABEL, sgd } from '../lib/facts.ts';
import {
  dayOf,
  GROUP,
  gstUnknown,
  plural,
  shortUrl,
  useReviewSummary,
  valueLine,
} from '../lib/review.ts';
import { isImported } from '../lib/sources.ts';
import type { CardGst } from './review-card.tsx';
import { FactFields } from './fact-fields.tsx';
import { ReviewTabs, ReviewToast } from './review.tsx';

type Body = Omit<ResolveConflictBody, 'facts'>;
interface Resolved {
  conflict: Conflict;
  fact: Fact;
}

const FAILED = "We couldn't save this just now. Nothing was changed.";
const CHANGED = 'This conflict changed since you loaded it. Check it again.';
const refsOf = (c: Conflict) => c.facts.map((m) => ({ id: m.id, version: m.version }));
/** What the assistant now says: the price, or the fact's title (ui-design copy). */
const saying = (f: Fact) => (f.type === 'product' ? sgd(f.value.price) : factTitle(f));
const sourceLabel = (m: ConflictFact) =>
  m.sourceName ? `From ${m.sourceName}, read ${dayOf(m.sourceDate)}` : 'Entered by you';

/** One source's column of `conflict-compare` (design.md §4.6; FEAT-014 ui-design). */
function Column({
  member,
  suggested,
  busy,
  disabled,
  gst,
  gstError,
  onGst,
  onUse,
}: {
  member: ConflictFact;
  suggested: boolean;
  busy: boolean;
  disabled: boolean;
  gst: CardGst | undefined;
  gstError: boolean;
  onGst: (g: CardGst) => void;
  onUse: () => void;
}) {
  const value = valueLine(member);
  // A spreadsheet row was imported: "Imported" instead of a confidence (FEAT-016).
  const imported = isImported(member.provenance?.location);
  const confidence =
    member.confidence === null || imported ? null : Math.round(member.confidence * 100);
  const needsGst = gstUnknown(member);
  const where = member.sourceName ? ` from ${member.sourceName}` : ' you entered';
  const what = member.type === 'product' ? sgd(member.value.price) : 'this value';
  return (
    <div
      className="conflict-column"
      role="group"
      aria-label={sourceLabel(member)}
      data-testid="conflict-column"
    >
      <div className="conflict-column__meta">
        {member.newer && (
          <span className="chip chip--info" aria-label="Newer, suggested">
            <span aria-hidden="true">◷ </span>Newer
          </span>
        )}
        {member.type === 'policy' && <span>{POLICY_KIND_LABEL[member.value.kind]}</span>}
        {imported && <span>Imported</span>}
        {confidence !== null && (
          <span className={confidence < 70 ? 'review-card__low' : undefined}>
            {confidence < 70 && <span aria-hidden="true">! </span>}
            {confidence}% confidence
          </span>
        )}
      </div>
      {value && (
        <p className={member.type === 'product' ? 'review-card__price' : 'review-card__text'}>
          {value}
        </p>
      )}
      {needsGst && <span className="chip chip--warning">GST treatment unknown</span>}
      {member.passage ? (
        <blockquote className="passage review-card__passage" cite={member.provenance?.url}>
          <span>
            {member.passage.before}
            <mark>{member.passage.quote}</mark>
            {member.passage.after}
          </span>
          <span className="review-card__caption">
            Website · {member.sourceName} · read {dayOf(member.sourceDate)}
            {member.provenance && (
              <>
                {' · '}
                <a href={member.provenance.url} target="_blank" rel="noreferrer noopener">
                  {shortUrl(member.provenance.url)}
                  <span aria-hidden="true"> ↗</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </>
            )}
          </span>
        </blockquote>
      ) : (
        <p className="review-card__caption">
          Entered by you · confirmed {dayOf(member.sourceDate)}
        </p>
      )}
      {needsGst && (
        <fieldset
          className="radio-group review-card__gst"
          id={`gst-${member.id}`}
          aria-describedby={`gst-${member.id}-help${gstError ? ` gst-${member.id}-error` : ''}`}
        >
          <legend className="field__label">Does this price include GST? (required)</legend>
          {(['inclusive', 'exclusive'] as const).map((g) => (
            <label className="radio" key={g}>
              <input
                type="radio"
                name={`gst-${member.id}`}
                checked={gst === g}
                onChange={() => onGst(g)}
                disabled={disabled}
              />
              {g === 'inclusive' ? 'Price includes GST' : 'Price is before GST'}
            </label>
          ))}
          <p className="field__help" id={`gst-${member.id}-help`}>
            Your assistant won't quote this price until you choose.
          </p>
          {gstError && (
            <p className="field__error" id={`gst-${member.id}-error`}>
              <span aria-hidden="true">!</span> Choose whether the price includes GST
            </p>
          )}
        </fieldset>
      )}
      <div className="conflict-column__action">
        <Button
          variant={suggested ? 'primary' : 'secondary'}
          onClick={onUse}
          disabled={disabled}
          aria-busy={busy || undefined}
          aria-label={`Use this value (${what}${where})`}
        >
          {busy ? 'Saving…' : 'Use this value'}
        </Button>
      </div>
    </div>
  );
}

/** design.md `conflict-compare` (KB-06, KB-17; UC-12) as bound in FEAT-014 ui-design. */
function ConflictCard({
  conflict,
  busy,
  error,
  gst,
  gstErrors,
  onGst,
  onUse,
  onEnter,
  onDisable,
}: {
  conflict: Conflict;
  busy: string | null;
  error: string | null;
  gst: ReadonlyMap<string, CardGst>;
  gstErrors: ReadonlySet<string>;
  onGst: (factId: string, g: CardGst) => void;
  onUse: (member: ConflictFact) => void;
  onEnter: () => void;
  onDisable: () => void;
}) {
  const headingId = `conflict-${conflict.id}`;
  const first = conflict.facts[0]!;
  const working = busy !== null;
  return (
    <section
      className="card conflict-card"
      aria-labelledby={headingId}
      data-testid="conflict-card"
      id={`c-${conflict.id}`}
    >
      <div className="review-card__meta">
        <span className="status-badge status-badge--conflict">
          {working ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <span aria-hidden="true">⚠</span>
          )}
          Conflict
        </span>
        <span className="review-card__kind">{GROUP[conflict.type].one}</span>
      </div>
      <div className="review-card__value">
        <h2 id={headingId}>{factTitle(first)}</h2>
        <p className="review-card__caption">
          {conflict.facts.length} sources disagree. Your assistant won't use this until you choose.
        </p>
      </div>
      <div className="conflict-columns">
        {conflict.facts.map((m) => (
          <Column
            key={m.id}
            member={m}
            suggested={conflict.suggestedId === m.id}
            busy={busy === m.id}
            disabled={working}
            gst={gst.get(m.id)}
            gstError={gstErrors.has(m.id)}
            onGst={(g) => onGst(m.id, g)}
            onUse={() => onUse(m)}
          />
        ))}
      </div>
      {error && (
        <div className="alert alert--danger" role="alert">
          <p>{error}</p>
        </div>
      )}
      <div className="conflict-card__footer">
        <Button variant="secondary" onClick={onEnter} disabled={working}>
          Enter a different value…
        </Button>
        <Button variant="danger-ghost" onClick={onDisable} disabled={working}>
          Disable this fact…
        </Button>
      </div>
    </section>
  );
}

function ResolvedRow({ resolved }: { resolved: Resolved }) {
  const { fact } = resolved;
  const disabled = fact.status === 'disabled';
  return (
    <article
      className="card review-card review-card--done conflict-card--done"
      aria-label={`${factTitle(fact)} ${disabled ? 'disabled' : 'resolved'}`}
      data-testid="conflict-done"
    >
      <span />
      <div className="review-card__done">
        <span className={`status-badge status-badge--${disabled ? 'rejected' : 'approved'}`}>
          <span className="status-badge__dot" aria-hidden="true" />
          {disabled ? 'Disabled' : 'Resolved'}
        </span>
        <span className="review-card__done-text">
          <b>{factTitle(fact)}</b>
          {disabled ? '' : ` · using ${valueLine(fact) ?? saying(fact)}`}
        </span>
        <Link to={`/knowledge/facts/${fact.id}`}>View in Knowledge</Link>
      </div>
    </article>
  );
}

/** "Enter the right value" (UC-12 2): SCR-APP-028's fields, prefilled from the suggested source. */
function EnterForm({
  conflict,
  onClose,
  onSubmit,
}: {
  conflict: Conflict;
  onClose: () => void;
  onSubmit: (body: Body) => Promise<void>;
}) {
  const kept = conflict.facts.find((m) => m.id === conflict.suggestedId) ?? conflict.facts[0]!;
  const [draft, setDraft] = useState<Draft>(() => fromFact(kept));
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const errors = validate(draft, false);
  const shown = (f: FieldName) => (submitted || touched[f] ? errors[f] : undefined);
  const save = useMutation({
    mutationFn: () => {
      // The resolve body names the kept fact, not a type.
      const fields: Partial<ReturnType<typeof createBody>> = createBody(draft);
      delete fields.type;
      return onSubmit({ action: 'enter', keepId: kept.id, ...fields } as Body);
    },
  });
  useEffect(() => {
    if (attempts) summaryRef.current?.focus();
  }, [attempts]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) {
      setAttempts((n) => n + 1);
      return;
    }
    save.mutate();
  }
  const errorList = Object.entries(errors) as [FieldName, string][];
  return (
    <form className="fact-form review-edit" onSubmit={submit} noValidate>
      {submitted && errorList.length > 0 && (
        <div className="alert alert--danger" role="alert" tabIndex={-1} ref={summaryRef}>
          <p className="alert__title">Check these fields</p>
          <ul>
            {errorList.map(([f, msg]) => (
              <li key={f}>
                <a href={`#fact-${f}`}>{msg}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {save.isError && (
        <div className="alert alert--danger" role="alert">
          <p>{FAILED}</p>
        </div>
      )}
      <FactFields
        draft={draft}
        set={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        shown={shown}
        blur={(f) => () => setTouched((t) => ({ ...t, [f]: true }))}
        readOnly={save.isPending}
        fixedType={kept.type}
      />
      <p>The other values will be rejected. You can see them later in the fact's history.</p>
      <div className="kaki-dialog__actions">
        <Button variant="secondary" type="button" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending || undefined}>
          {save.isPending ? 'Saving…' : 'Use this value'}
        </Button>
      </div>
    </form>
  );
}

/** SCR-APP-020 Review · Conflicts at `/review/conflicts` (KB-06, KB-17; UC-12). */
export function ConflictsPage() {
  const queryClient = useQueryClient();
  const summary = useReviewSummary();
  const list = useQuery({ queryKey: ['conflicts'], queryFn: api.conflicts });
  const [resolved, setResolved] = useState<ReadonlyMap<string, Resolved>>(new Map());
  const [busy, setBusy] = useState<ReadonlyMap<string, string>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [gst, setGst] = useState<ReadonlyMap<string, CardGst>>(new Map());
  const [gstErrors, setGstErrors] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<{ message: string } | null>(null);
  const [entering, setEntering] = useState<Conflict | null>(null);
  const [disabling, setDisabling] = useState<Conflict | null>(null);
  const [disableBusy, setDisableBusy] = useState(false);

  const set = <V,>(m: ReadonlyMap<string, V>, k: string, v: V | null) => {
    const next = new Map(m);
    if (v === null) next.delete(k);
    else next.set(k, v);
    return next;
  };

  /** One resolve call; `true` when it's done (resolved, or replaced after a 409). */
  async function resolve(conflict: Conflict, body: Body, pressed: string): Promise<void> {
    setBusy((b) => set(b, conflict.id, pressed));
    setErrors((e) => set(e, conflict.id, null));
    try {
      const { fact } = await api.resolveConflict({
        ...body,
        facts: refsOf(conflict),
      } as ResolveConflictBody);
      setResolved((r) => set(r, conflict.id, { conflict, fact }));
      setToast({
        message:
          fact.status === 'disabled'
            ? `Disabled. Your assistant won't use ${factTitle(fact)} until you enable it in Knowledge.`
            : `Conflict resolved. Your assistant uses ${saying(fact)} from now on.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['review-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['review'] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict_changed') {
        const fresh = (err.details.conflict ?? null) as Conflict | null;
        queryClient.setQueryData<ConflictList>(['conflicts'], (d) =>
          d
            ? {
                conflicts: fresh
                  ? d.conflicts.map((c) => (c.id === conflict.id ? fresh : c))
                  : d.conflicts.filter((c) => c.id !== conflict.id),
              }
            : d,
        );
        setToast({ message: CHANGED });
        void queryClient.invalidateQueries({ queryKey: ['review-summary'] });
      } else {
        setErrors((e) => set(e, conflict.id, FAILED));
        throw err;
      }
    } finally {
      setBusy((b) => set(b, conflict.id, null));
    }
  }

  function use(conflict: Conflict, member: ConflictFact) {
    const choice = gst.get(member.id);
    if (gstUnknown(member) && !choice) {
      setGstErrors((s) => new Set(s).add(member.id));
      document.getElementById(`gst-${member.id}`)?.querySelector('input')?.focus();
      return;
    }
    void resolve(
      conflict,
      {
        action: 'use',
        keepId: member.id,
        ...(choice && gstUnknown(member) ? { gstTreatment: choice } : {}),
      },
      member.id,
    ).catch(() => undefined);
  }

  const forbidden = list.error instanceof ApiError && list.error.status === 403;
  const conflicts = list.data?.conflicts ?? [];
  const open = conflicts.filter((c) => !resolved.has(c.id)).length;
  const waiting = summary.data?.needsReview ?? 0;
  const disableTarget =
    disabling &&
    (disabling.facts.find((m) => m.id === disabling.suggestedId) ?? disabling.facts[0]!);

  return (
    <div className="review">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title">Review</h1>
          <p className="page-lede">
            When your sources disagree, your assistant uses neither until you choose.
          </p>
        </div>
      </div>
      <ReviewTabs
        count={summary.data && summary.data.needsReview + summary.data.conflicted}
        conflicts={summary.data?.conflicts}
        corrections={summary.data?.openCorrections}
      />
      <div className="review-queue">
        {forbidden && (
          <EmptyState title="You can't review facts">
            Only the Owner or an Admin can resolve conflicts.
          </EmptyState>
        )}
        {list.isPending && (
          <div className="review-groups" aria-busy="true" aria-label="Loading conflicts">
            <div className="card review-skeleton">
              <div className="skeleton-field review-skeleton__badge" />
              <div className="conflict-columns">
                {[0, 1].map((i) => (
                  <div key={i} className="conflict-column">
                    <div className="skeleton-field review-skeleton__title" />
                    <div className="skeleton-field review-skeleton__passage" />
                    <div className="skeleton-field review-skeleton__actions" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {list.isError && !forbidden && (
          <ErrorState
            title="We couldn't load your conflicts"
            action={
              <Button variant="secondary" onClick={() => void list.refetch()}>
                Try again
              </Button>
            }
          >
            Nothing you resolved was lost.
          </ErrorState>
        )}
        {list.isSuccess && conflicts.length === 0 && (
          <EmptyState
            title="No conflicts"
            action={
              <Button asChild variant="secondary">
                <Link to="/review">Back to facts</Link>
              </Button>
            }
          >
            {`When two sources state different prices or rules for the same thing, you'll choose the right one here.${waiting ? ` ${plural(waiting, 'fact is', 'facts are')} waiting for review.` : ''}`}
          </EmptyState>
        )}
        {conflicts.length > 0 && (
          <div className="review-groups conflict-list">
            {conflicts.map((c) => {
              const r = resolved.get(c.id);
              return r ? (
                <ResolvedRow key={c.id} resolved={r} />
              ) : (
                <ConflictCard
                  key={`${c.id}-${c.facts.map((m) => m.version).join('.')}`}
                  conflict={c}
                  busy={busy.get(c.id) ?? null}
                  error={errors.get(c.id) ?? null}
                  gst={gst}
                  gstErrors={gstErrors}
                  onGst={(id, g) => {
                    setGst((m) => set(m, id, g));
                    setGstErrors((s) => {
                      const next = new Set(s);
                      next.delete(id);
                      return next;
                    });
                  }}
                  onUse={(m) => use(c, m)}
                  onEnter={() => setEntering(c)}
                  onDisable={() => setDisabling(c)}
                />
              );
            })}
          </div>
        )}
      </div>

      <FormDialog
        open={entering !== null}
        onOpenChange={(o) => (o ? undefined : setEntering(null))}
        title="Enter the right value"
      >
        {entering && (
          <EnterForm
            conflict={entering}
            onClose={() => setEntering(null)}
            onSubmit={async (body) => {
              await resolve(entering, body, 'enter');
              setEntering(null);
            }}
          />
        )}
      </FormDialog>
      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(o) => (o ? undefined : setDisabling(null))}
        title={disableTarget ? `Disable ${factTitle(disableTarget)}?` : 'Disable this fact?'}
        confirmLabel={disableBusy ? 'Working…' : 'Disable fact'}
        confirmVariant="danger"
        busy={disableBusy}
        onConfirm={() => {
          if (!disabling || !disableTarget) return;
          setDisableBusy(true);
          void resolve(disabling, { action: 'disable', keepId: disableTarget.id }, 'disable')
            .catch(() => undefined)
            .finally(() => {
              setDisableBusy(false);
              setDisabling(null);
            });
        }}
      >
        <p>
          Your assistant won't use any of these values. You can enable the fact again in Knowledge.
        </p>
      </ConfirmDialog>
      <div className="sr-only" aria-live="polite">
        {list.isSuccess ? `${plural(open, 'conflict')} to resolve` : ''}
      </div>
      <ReviewToast toast={toast} onClose={() => setToast(null)} onUndo={() => undefined} />
    </div>
  );
}
