import type { Fact } from '@kaki/contracts';
import { Button, ErrorState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import {
  BLANK,
  createBody,
  fromFact,
  patchBody,
  TYPE_OPTIONS,
  validate,
  type Draft,
  type FieldName,
} from '../lib/fact-draft.ts';
import { dayLabel, factTitle, promotionWindow, sgToday } from '../lib/facts.ts';
import { DeleteFactDialog, type DeleteOutcome } from './delete-fact.tsx';
import { FactFields } from './fact-fields.tsx';
import { StatusBadge } from './facts.tsx';
import { FactProvenance } from './fact-provenance.tsx';
import { NotFound } from './system.tsx';

/** The saved toast (FEAT-022, FEAT-011 ui-design "saved"). */
function savedToast(d: Draft): string {
  if (d.type === 'promotion' && d.validFrom && d.validFrom > sgToday())
    return `Fact saved. Your assistant starts using it on ${dayLabel(d.validFrom)}.`;
  return 'Fact saved. Your assistant uses it from now on.';
}

const DELETE_TOAST: Record<DeleteOutcome, string> = {
  deleted: 'Fact deleted.',
  'already-deleted': 'This fact was already deleted.',
};

/** SCR-APP-028 Fact: create at `/knowledge/facts/new`, edit at `/knowledge/facts/:id` (KB-07, KB-15). */
export function FactPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const editing = id !== undefined;
  const loaded = useQuery({
    queryKey: ['fact', id],
    queryFn: () => api.fact(id!),
    enabled: editing,
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });

  if (!editing) return <FactForm fact={null} prefill={prefillOf(search)} />;
  if (loaded.error instanceof ApiError && loaded.error.status === 404) return <NotFound />;
  if (loaded.isError)
    return (
      <ErrorState
        title="We couldn't load this fact"
        action={
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Try again
          </Button>
        }
      />
    );
  if (!loaded.data)
    return (
      <div className="fact-form" aria-busy="true" aria-label="Loading fact">
        <div className="skeleton-field" />
        <div className="skeleton-field" />
        <div className="skeleton-field" />
      </div>
    );
  return (
    <FactForm key={`${loaded.data.fact.id}-${loaded.data.fact.version}`} fact={loaded.data.fact} />
  );
}

/**
 * A new fact started elsewhere: `?type=faq&question=…` from the business profile's
 * suggested questions (FEAT-009 ui-design). Both stay editable.
 */
function prefillOf(search: URLSearchParams): Draft {
  const type = TYPE_OPTIONS.find((o) => o.value === search.get('type'))?.value ?? BLANK.type;
  return { ...BLANK, type, question: (search.get('question') ?? '').slice(0, 300) };
}

function FactForm({ fact, prefill = BLANK }: { fact: Fact | null; prefill?: Draft }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(fact ? fromFact(fact) : prefill);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  // KB-15: a stored "unknown" GST treatment may stay through other edits.
  const unknownGst = fact?.gstTreatment === 'unknown' && !draft.gst;
  const errors = validate(draft, unknownGst);
  const shown = (f: FieldName) => (submitted || touched[f] ? errors[f] : undefined);
  const patch = fact ? patchBody(fact, draft) : null;

  const save = useMutation({
    mutationFn: () => (fact ? api.updateFact(fact.id, patch!) : api.createFact(createBody(draft))),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['facts'] });
      if (fact) queryClient.removeQueries({ queryKey: ['fact', fact.id] });
      void navigate('/knowledge', { state: { toast: savedToast(draft) } });
    },
  });
  const failure =
    save.error instanceof ApiError ? save.error.code : save.error ? 'unavailable' : null;
  // Rejected and conflicted facts are resolved in Review (FEAT-013/014), not here.
  const locked =
    failure === 'invalid_state' || fact?.status === 'rejected' || fact?.status === 'conflicted';
  const readOnly = save.isPending || locked;

  // Each submit with errors moves focus to the summary (design.md §4.2).
  const [attempts, setAttempts] = useState(0);
  useEffect(() => {
    if (attempts) summaryRef.current?.focus();
  }, [attempts]);

  const set = (patchDraft: Partial<Draft>) => setDraft((d) => ({ ...d, ...patchDraft }));
  const blur = (f: FieldName) => () => setTouched((t) => ({ ...t, [f]: true }));
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['fact', fact?.id] });

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) {
      setAttempts((n) => n + 1);
      return;
    }
    if (fact && !patch) return;
    save.mutate();
  }

  const title = fact ? factTitle(fact).split(', ')[0]! : 'Add a fact';
  const errorList = Object.entries(errors) as [FieldName, string][];
  const ended = fact?.type === 'promotion' && promotionWindow(fact).state === 'ended';

  return (
    <div className="fact-page">
      <Link className="back-link" to="/knowledge">
        Facts
      </Link>
      <h1 className="page-title">{title}</h1>

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
      {failure === 'version_conflict' && (
        <div className="alert alert--warning" role="alert">
          <p>
            Someone else saved this fact while you were editing. Reload to see their version, then
            make your change again.
          </p>
          <Button variant="secondary" onClick={reload}>
            Reload
          </Button>
        </div>
      )}
      {locked && (
        <div className="alert alert--info" role="alert">
          <p>This fact can't be edited here.</p>
        </div>
      )}
      {failure && failure !== 'version_conflict' && failure !== 'invalid_state' && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't save the fact just now. Nothing was changed. Try again in a moment.</p>
        </div>
      )}
      {fact?.gstTreatment === 'unknown' && !locked && (
        <div className="alert alert--warning">
          <p>Choose whether this price includes GST. Your assistant won't quote it until you do.</p>
        </div>
      )}
      {ended && fact.validUntil && (
        <div className="alert alert--info">
          <p>
            This promotion ended on {dayLabel(fact.validUntil)}, so your assistant no longer
            mentions it. Change the end date to run it again.
          </p>
        </div>
      )}

      <form className="fact-form card" onSubmit={submit} noValidate>
        <FactFields
          draft={draft}
          set={set}
          shown={shown}
          blur={blur}
          readOnly={readOnly}
          fixedType={fact?.type ?? null}
        />
        {fact && (
          <div className="fact-form__status">
            <StatusBadge status={fact.status} />
            <button
              type="button"
              role="switch"
              className="toggle"
              aria-checked={draft.useInAnswers}
              aria-labelledby="fact-use-label"
              disabled={readOnly || fact.status === 'needs_review'}
              onClick={() => set({ useInAnswers: !draft.useInAnswers })}
            >
              <span className="toggle__thumb" aria-hidden="true" />
            </button>
            <span id="fact-use-label">Use in answers</span>
          </div>
        )}

        {fact && <FactProvenance fact={fact} />}

        <div className="action-bar">
          <Button
            type="submit"
            disabled={readOnly || (fact !== null && patch === null)}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? 'Saving…' : 'Save fact'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => void navigate('/knowledge')}>
            Cancel
          </Button>
          {fact && (
            <Button
              variant="danger-ghost"
              type="button"
              className="action-bar__end"
              disabled={save.isPending}
              onClick={() => setDeleting(true)}
            >
              Delete fact
            </Button>
          )}
        </div>
      </form>

      {fact && (
        <DeleteFactDialog
          fact={deleting ? fact : null}
          onClose={() => setDeleting(false)}
          conflictAction={
            <Button
              variant="secondary"
              onClick={() => {
                setDeleting(false);
                reload();
              }}
            >
              Reload
            </Button>
          }
          onDone={async (outcome) => {
            await queryClient.invalidateQueries({ queryKey: ['facts'] });
            queryClient.removeQueries({ queryKey: ['fact', fact.id] });
            void navigate('/knowledge', { state: { toast: DELETE_TOAST[outcome] } });
          }}
        />
      )}
    </div>
  );
}
