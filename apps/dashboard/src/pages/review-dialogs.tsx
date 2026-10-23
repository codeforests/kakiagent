import type { ApprovePreview, FactRef, ReviewFact, ReviewScopeQuery } from '@kaki/contracts';
import { Button, ConfirmDialog, FormDialog } from '@kaki/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { editBody, fromFact, validate, type Draft, type FieldName } from '../lib/fact-draft.ts';
import { GROUPS, plural } from '../lib/review.ts';
import { FactFields } from './fact-fields.tsx';

/**
 * design.md `approve-all-dialog` (KB-16; UC-15 3a, 3b) as bound in FEAT-013 ui-design:
 * the preview's counts by type, the excluded facts, then the execute with the preview's
 * hash. A stale preview keeps the dialog open with the fresh counts. Cancel sends nothing.
 */
export function ApproveAllDialog({
  open,
  scope,
  sourceName,
  onClose,
  onDone,
}: {
  open: boolean;
  scope: ReviewScopeQuery;
  sourceName: string | null;
  onClose: () => void;
  onDone: (facts: FactRef[]) => void;
}) {
  const [fresh, setFresh] = useState<ApprovePreview | null>(null);
  const loaded = useQuery({
    queryKey: ['review-preview', scope.sourceId, scope.type],
    queryFn: () => api.approvePreview(scope),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const preview = fresh ?? loaded.data ?? null;
  const run = useMutation({
    mutationFn: (p: ApprovePreview) => api.approveAll(scope, p.previewHash),
    onSuccess: ({ facts }) => {
      setFresh(null);
      onDone(facts);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'preview_stale')
        setFresh(err.details.preview as ApprovePreview);
    },
  });
  const stale = run.error instanceof ApiError && run.error.code === 'preview_stale';
  const failed = run.isError && !stale;
  const close = () => {
    setFresh(null);
    run.reset();
    onClose();
  };
  const count = preview?.count ?? 0;
  const where = scope.sourceId && sourceName ? ` from ${sourceName}` : '';
  const excluded = preview
    ? [
        preview.excluded.gstUnknown > 0 &&
          `${plural(preview.excluded.gstUnknown, 'price')} with an unknown GST treatment`,
        preview.excluded.conflicted > 0 && plural(preview.excluded.conflicted, 'conflicted fact'),
      ].filter(Boolean)
    : [];

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      title={preview ? `Approve ${plural(count, 'fact')}${where}?` : 'Approve all facts?'}
      confirmLabel={`Approve ${plural(count, 'fact')}`}
      onConfirm={() => preview && count > 0 && run.mutate(preview)}
      busy={run.isPending}
      confirmDisabled={!preview || count === 0}
      alert={
        <>
          {stale && (
            <div className="alert alert--info" role="alert">
              <p>Some facts changed while this was open. Check the new count, then approve.</p>
            </div>
          )}
          {failed && (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't approve the facts just now. Nothing was changed.</p>
            </div>
          )}
          {loaded.isError && !preview && (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't count the facts just now.</p>
              <Button variant="secondary" onClick={() => void loaded.refetch()}>
                Try again
              </Button>
            </div>
          )}
        </>
      }
    >
      {preview ? (
        <>
          <table className="confirm-table" data-testid="approve-all-counts">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Facts</th>
              </tr>
            </thead>
            <tbody>
              {GROUPS.filter((g) => preview.byType[g.type] > 0).map((g) => (
                <tr key={g.type}>
                  <td>{g.label}</td>
                  <td className="confirm-table__num">{preview.byType[g.type]}</td>
                </tr>
              ))}
              <tr className="confirm-table__total">
                <td>Total</td>
                <td className="confirm-table__num">{count}</td>
              </tr>
            </tbody>
          </table>
          {excluded.length > 0 && (
            <div className="alert alert--warning">
              <p>
                {excluded.join(' and ')}{' '}
                {preview.excluded.gstUnknown + preview.excluded.conflicted === 1
                  ? "isn't"
                  : "aren't"}{' '}
                included. Review them one by one.
              </p>
            </div>
          )}
          <p>Each approval is recorded in the audit log with your name and the time.</p>
        </>
      ) : (
        <div aria-busy="true" aria-label="Counting facts">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}
    </ConfirmDialog>
  );
}

/**
 * "Edit and approve" (UC-15 2; FEAT-013 ui-design): SCR-APP-028's fields in a dialog,
 * the passage under them for reference, and one call that saves and approves.
 */
export function EditApproveDialog({
  fact,
  onClose,
  onDone,
  onReload,
}: {
  fact: ReviewFact | null;
  onClose: () => void;
  onDone: (ref: FactRef) => void;
  onReload: () => void;
}) {
  return (
    <FormDialog
      open={fact !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Edit and approve"
    >
      {fact && (
        <EditApproveForm
          key={`${fact.id}-${fact.version}`}
          fact={fact}
          onClose={onClose}
          onDone={onDone}
          onReload={onReload}
        />
      )}
    </FormDialog>
  );
}

function EditApproveForm({
  fact,
  onClose,
  onDone,
  onReload,
}: {
  fact: ReviewFact;
  onClose: () => void;
  onDone: (ref: FactRef) => void;
  onReload: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => fromFact(fact));
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  // Approving needs a GST choice for every price (KB-15), so "unknown" can't stay.
  const errors = validate(draft, false);
  const shown = (f: FieldName) => (submitted || touched[f] ? errors[f] : undefined);
  const save = useMutation({
    mutationFn: () => api.approveFact(fact.id, editBody(fact, draft)),
    onSuccess: ({ fact: saved }) => onDone({ id: saved.id, version: saved.version }),
  });
  useEffect(() => {
    if (attempts) summaryRef.current?.focus();
  }, [attempts]);
  const code = save.error instanceof ApiError ? save.error.code : save.error ? 'unavailable' : null;

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
      {code === 'version_conflict' || code === 'invalid_state' ? (
        <div className="alert alert--warning" role="alert">
          <p>Someone else changed this fact. Close and reload to see it.</p>
          <Button variant="secondary" type="button" onClick={onReload}>
            Reload
          </Button>
        </div>
      ) : (
        code && (
          <div className="alert alert--danger" role="alert">
            <p>We couldn't save this just now. Nothing was changed.</p>
          </div>
        )
      )}
      <FactFields
        draft={draft}
        set={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        shown={shown}
        blur={(f) => () => setTouched((t) => ({ ...t, [f]: true }))}
        readOnly={save.isPending}
        fixedType={fact.type}
      />
      {fact.passage && (
        <blockquote className="passage">
          {fact.passage.before}
          <mark>{fact.passage.quote}</mark>
          {fact.passage.after}
        </blockquote>
      )}
      <div className="kaki-dialog__actions">
        <Button variant="secondary" type="button" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending || undefined}>
          {save.isPending ? 'Approving…' : 'Approve fact'}
        </Button>
      </div>
    </form>
  );
}
