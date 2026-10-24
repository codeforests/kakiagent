import type {
  CorrectionDetail,
  CorrectionEdit,
  CorrectionItem,
  CorrectionReplay,
  Fact,
  FactValueView,
  ProposedChange,
} from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState, ErrorState, FormDialog } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { relativeTime, useBotName } from '../lib/coach.ts';
import {
  acceptedLine,
  correctionCompleteLine,
  correctionPending,
  correctionProgress,
  correctionRows,
  decisionLabel,
  draftOf,
  effectiveChange,
  factEdit,
  fixSummary,
  matchedCaption,
  noReplayCaption,
  pastAnswersLede,
  SOURCE_LABEL,
  sourceTone,
  staleLine,
  useCorrectionsChanged,
  withCorrectionTurn,
} from '../lib/corrections.ts';
import { fromFact, validate, type Draft, type FieldName } from '../lib/fact-draft.ts';
import { factValue, STATUS_LABEL, STATUS_TONE } from '../lib/facts.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { dateLabel, driveReplay, RATE_LIMIT_PAUSE_MS, type ReplayFailure } from '../lib/replay.ts';
import { AnswerCompare } from './answer-compare.tsx';
import { CorrectionsForbidden } from './corrections.tsx';
import { FactFields } from './fact-fields.tsx';

type Mode = 'idle' | 'running' | 'pausing' | ReplayFailure;
type Problem = 'stale' | 'not_editable' | 'failed' | null;

function Back() {
  return (
    <Link className="back-link" to="/review/corrections">
      Corrections
    </Link>
  );
}

/** The current value of a re-confirm item's fact (the change itself carries no value). */
function useReconfirmFact(change: ProposedChange | undefined) {
  const factId = change?.kind === 'reconfirm' ? change.factId : null;
  return useQuery({
    queryKey: ['fact', factId ?? ''],
    queryFn: () => api.fact(factId!),
    enabled: factId !== null,
  });
}

const viewOf = (f: Fact): FactValueView => ({
  value: f.value as Record<string, unknown>,
  gstTreatment: f.gstTreatment ?? null,
  validFrom: f.validFrom ?? null,
  validUntil: f.validUntil ?? null,
});

/**
 * `/review/corrections/:id`: SCR-APP-022 Correction (KB-18, KB-17, UC-16; FEAT-018 ui-design).
 * Open items are accepted, edited or closed; an accepted fact edit then drives its replay
 * one `…/replay/next` at a time and shows the old and new answers side by side.
 */
export function CorrectionPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const changed = useCorrectionsChanged();
  const botName = useBotName();
  const key = ['correction', id] as const;
  const detail = useQuery({
    queryKey: key,
    queryFn: () => api.correction(id),
    staleTime: Infinity,
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
  });
  const data = detail.data;
  const item = data?.correction;
  const factQuery = useReconfirmFact(item?.change);
  const intervals = useQuery({
    queryKey: ['review-intervals'],
    queryFn: api.reviewIntervals,
    enabled: item?.change.kind === 'reconfirm',
  });

  const [problem, setProblem] = useState<Problem>(null);
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [justAccepted, setJustAccepted] = useState(false);
  const [mode, setMode] = useState<Mode>('idle');
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const stop = useRef(false);
  const bannerRef = useRef<HTMLDivElement>(null);

  const setDetail = (fn: (old: CorrectionDetail) => CorrectionDetail) =>
    queryClient.setQueryData(key, (old: CorrectionDetail | undefined) => (old ? fn(old) : old));

  const run = () => {
    stop.current = false;
    setFailedAt(null);
    setMode('running');
    void driveReplay(
      () => api.correctionReplayNext(id),
      (res) =>
        setDetail((old) =>
          old.replay ? { ...old, replay: withCorrectionTurn(old.replay, res.turn) } : old,
        ),
      () => stop.current,
    ).then((result) => {
      if (result.kind === 'error') {
        const current = queryClient.getQueryData<CorrectionDetail>(key);
        setFailedAt(current?.replay?.turns.find((t) => t.status === 'pending')?.messageId ?? null);
        setMode(result.failure);
        if (result.failure === 'rate_limited') {
          setCooling(true);
          setTimeout(() => setCooling(false), RATE_LIMIT_PAUSE_MS);
        }
      } else setMode('idle');
    });
  };

  // Leaving the page stops the loop after the call in flight.
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );
  useEffect(() => {
    if (justAccepted) bannerRef.current?.focus();
  }, [justAccepted]);

  const onDecisionError = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'correction_closed') {
      setProblem(null);
      void detail.refetch();
      changed();
      return;
    }
    setProblem(
      err instanceof ApiError && err.code === 'correction_stale'
        ? 'stale'
        : err instanceof ApiError && err.code === 'not_editable'
          ? 'not_editable'
          : 'failed',
    );
  };

  const accept = useMutation({
    mutationFn: (edit: CorrectionEdit | null) => api.acceptCorrection(id, edit),
    onSuccess: (res) => {
      setEditing(false);
      setProblem(null);
      setDetail((old) => ({ ...old, correction: res.correction, replay: res.replay }));
      setJustAccepted(true);
      changed();
      void queryClient.invalidateQueries({ queryKey: ['fact'] });
      if (res.replay && correctionPending(res.replay)) run();
    },
    onError: (err) => {
      // An invalid edit stays in the dialog with its message.
      if (err instanceof ApiError && err.code === 'invalid_correction' && editing) return;
      setEditing(false);
      onDecisionError(err);
    },
  });
  const close = useMutation({
    mutationFn: () => api.closeCorrection(id),
    onSuccess: (res) => {
      setClosing(false);
      setDetail((old) => ({ ...old, correction: res.correction }));
      changed();
    },
    onError: (err) => {
      setClosing(false);
      onDecisionError(err);
    },
  });

  const err = detail.error;
  if (err instanceof ApiError && err.status === 403) return <CorrectionsForbidden />;
  if (err instanceof ApiError && err.status === 404)
    return (
      <div className="replay-page correction-page">
        <Back />
        <EmptyState
          title="This suggestion isn't available."
          action={<Link to="/review/corrections">Back to corrections</Link>}
        />
      </div>
    );

  if (detail.isPending)
    return (
      <div className="replay-page correction-page" aria-busy="true" aria-label="Loading">
        <Back />
        <div className="skeleton-field review-skeleton__title" />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="card review-skeleton">
            <div className="skeleton-field review-skeleton__passage" />
          </div>
        ))}
      </div>
    );
  if (detail.isError || !data || !item)
    return (
      <div className="replay-page correction-page">
        <Back />
        <ErrorState
          title="Couldn't load this suggestion."
          action={
            <Button variant="secondary" onClick={() => void detail.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );

  const open = item.status === 'open';
  const change = effectiveChange(item);
  const reconfirm = item.change.kind === 'reconfirm';
  const busy = accept.isPending || close.isPending;
  const fact = factQuery.data?.fact;

  return (
    <div className="replay-page correction-page">
      <Back />
      <h1 className="page-title">{fixSummary(change)}</h1>
      <p className="correction-page__meta">
        <span className={`chip chip--${sourceTone(item.source)}`}>{SOURCE_LABEL[item.source]}</span>
        <span>Suggested {relativeTime(item.createdAt)}</span>
      </p>

      {!open && item.status !== 'dismissed' && (
        <div
          className="coach-decided coach-decided--success"
          role="status"
          tabIndex={-1}
          ref={bannerRef}
        >
          {justAccepted ? acceptedLine(change) : decisionLabel(item)}
          {!justAccepted && item.decidedAt && ` ${relativeTime(item.decidedAt)}.`}
        </div>
      )}
      {item.status === 'dismissed' && (
        <div className="coach-decided coach-decided--neutral" role="status">
          {item.closedBySystem
            ? 'Closed automatically: the fact was confirmed or changed since.'
            : `Closed${item.decidedAt ? ` ${relativeTime(item.decidedAt)}` : ''}. Nothing in your knowledge changed.`}
        </div>
      )}
      {problem === 'stale' && (
        <div className="alert alert--warning" role="alert">
          <p>This fact changed after the suggestion was made, so it wasn't applied.</p>
          <Button
            variant="secondary"
            onClick={() => {
              setProblem(null);
              void detail.refetch();
            }}
          >
            Reload
          </Button>
        </div>
      )}
      {problem === 'not_editable' && (
        <div className="alert alert--danger" role="alert">
          <p>This fix can't be edited here.</p>
        </div>
      )}
      {problem === 'failed' && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't save this just now. Nothing was changed.</p>
        </div>
      )}

      {open && <Origin item={item} detail={data} intervals={intervals.data?.intervals} />}

      <section className="correction-section" aria-labelledby="facts-involved">
        <h2 id="facts-involved" className="correction-section__title">
          Facts involved
        </h2>
        {item.facts.length === 0 ? (
          <p className="field__help">
            {change.kind === 'edit_hours'
              ? 'Opening hours from your business profile.'
              : 'A new fact, not in your knowledge yet.'}
          </p>
        ) : (
          <ul className="correction-facts">
            {item.facts.map((f) => (
              <li key={f.id} className="correction-facts__row">
                {f.status === 'deleted' ? (
                  <span>{f.label}</span>
                ) : (
                  <Link to={`/knowledge/facts/${f.id}`}>{f.label}</Link>
                )}
                {f.status === 'deleted' ? (
                  <span className="chip chip--danger">Deleted</span>
                ) : (
                  <span className={`status-badge status-badge--${STATUS_TONE[f.status]}`}>
                    {STATUS_LABEL[f.status]}
                  </span>
                )}
                {f.lastConfirmedAt && (
                  <span className="source-row__meta">
                    Last confirmed {dateLabel(f.lastConfirmedAt)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="correction-section" aria-labelledby="proposed-fix">
        <h2 id="proposed-fix" className="correction-section__title">
          {open ? 'Proposed fix' : 'The fix'}
        </h2>
        {item.status === 'edited_and_accepted' && (
          <p className="field__help">Edited before accepting</p>
        )}
        <FixDiff change={change} current={fact ? factValue(fact) : null} />
        {item.acceptedChange && (
          <details className="correction-original">
            <summary>Show the original suggestion</summary>
            <FixDiff change={item.change} current={null} />
          </details>
        )}
        {open && (
          <>
            <div className="coach-proposal__actions">
              <Button
                onClick={() => accept.mutate(null)}
                disabled={busy}
                aria-busy={(accept.isPending && !editing) || undefined}
              >
                {accept.isPending && !editing
                  ? reconfirm
                    ? 'Re-confirming…'
                    : 'Accepting…'
                  : reconfirm
                    ? 'Re-confirm'
                    : 'Accept'}
              </Button>
              {item.change.kind !== 'edit_hours' && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    accept.reset();
                    setEditing(true);
                  }}
                  disabled={busy || (reconfirm && !fact)}
                >
                  {reconfirm ? 'Edit fact' : 'Edit fix'}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setClosing(true)} disabled={busy}>
                Close with no change
              </Button>
            </div>
            {item.change.kind === 'edit_hours' && (
              <p className="coach-proposal__caption">
                To change other days, edit them in{' '}
                <Link to="/settings/business-profile">Business profile</Link>.
              </p>
            )}
          </>
        )}
      </section>

      {!open && item.status !== 'dismissed' && (
        <PastAnswers
          change={change}
          replay={data.replay}
          botName={botName}
          mode={mode}
          failedAt={failedAt}
          cooling={cooling}
          onRun={run}
          onPause={() => {
            stop.current = true;
            setMode('pausing');
          }}
        />
      )}

      <EditFixDialog
        open={editing}
        item={item}
        fact={fact ?? null}
        busy={accept.isPending}
        error={accept.error}
        onClose={() => setEditing(false)}
        onSubmit={(edit) => accept.mutate(edit)}
      />
      <ConfirmDialog
        open={closing}
        onOpenChange={(o) => !o && setClosing(false)}
        title="Close this suggestion?"
        confirmLabel="Close suggestion"
        onConfirm={() => close.mutate()}
        busy={close.isPending}
      >
        Nothing in your knowledge changes.
      </ConfirmDialog>
    </div>
  );
}

/** "Where it came from": the coaching exchange, the conversation excerpt or the stale clock. */
function Origin({
  item,
  detail,
  intervals,
}: {
  item: CorrectionItem;
  detail: CorrectionDetail;
  intervals: Parameters<typeof staleLine>[2];
}) {
  const botName = useBotName();
  const { coaching, conversation } = detail.context;
  const change = item.change;
  if (change.kind !== 'reconfirm' && !coaching && !conversation?.length) return null;
  return (
    <section className="correction-section" aria-labelledby="came-from">
      <h2 id="came-from" className="correction-section__title">
        Where it came from
      </h2>
      {change.kind === 'reconfirm' && (
        <p>
          {staleLine(change.lastConfirmedAt, change.factType, intervals)}{' '}
          <Link to="/review/corrections?intervals=1">Change intervals</Link>
        </p>
      )}
      {coaching && (
        <div className="correction-thread">
          {coaching.question && (
            <div className="coach-bubble coach-bubble--owner">
              <span className="coach-bubble__who">You</span>
              <p className="coach-bubble__text">{coaching.question}</p>
            </div>
          )}
          <div className="coach-bubble coach-bubble--agent">
            <span className="coach-bubble__who">{botName} · coaching</span>
            <p className="coach-bubble__text">{coaching.proposal}</p>
          </div>
          {item.coachingSessionId && (
            <Link to={`/coach?session=${item.coachingSessionId}`}>Open in Coach</Link>
          )}
        </div>
      )}
      {conversation && conversation.length > 0 && (
        <div className="correction-thread">
          {conversation.map((m, i) => (
            <div
              key={i}
              className={`coach-bubble ${m.author === 'visitor' ? 'coach-bubble--visitor' : 'coach-bubble--original'}`}
            >
              <span className="coach-bubble__who">
                {m.author === 'visitor'
                  ? 'Customer'
                  : m.author === 'agent'
                    ? `${botName} · AI`
                    : m.author === 'staff'
                      ? 'Staff'
                      : 'System'}
              </span>
              <p className="coach-bubble__text">{m.text}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** The `correction-item` diff: "Was" struck through on danger-soft, "Now" on success-soft. */
function FixDiff({ change, current }: { change: ProposedChange; current: string | null }) {
  if (change.kind === 'reconfirm')
    return (
      <>
        {current && <p className="correction-current">{current}</p>}
        <p className="field__help">
          No change. Re-confirming keeps this value and resets the review clock.
        </p>
      </>
    );
  return (
    <dl className="coach-diff">
      {correctionRows(change).map((r) => (
        <div key={r.label} className="coach-diff__row">
          <dt>{r.label}</dt>
          <dd>
            {r.was !== null && (
              <span className="coach-diff__was">
                <span className="coach-diff__tag">Was</span> <s>{r.was}</s>
              </span>
            )}
            <span className="coach-diff__now">
              <span className="coach-diff__tag">Now</span> {r.now}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "Past answers": the replay's progress and one `answer-compare` row per question. */
function PastAnswers({
  change,
  replay,
  botName,
  mode,
  failedAt,
  cooling,
  onRun,
  onPause,
}: {
  change: ProposedChange;
  replay: CorrectionReplay | null;
  botName: string;
  mode: Mode;
  failedAt: string | null;
  cooling: boolean;
  onRun: () => void;
  onPause: () => void;
}) {
  if (!replay || replay.turns.length === 0) {
    const caption = noReplayCaption(change);
    return caption ? <p className="field__help">{caption}</p> : null;
  }
  const pending = correctionPending(replay);
  const running = mode === 'running' || mode === 'pausing';
  const answering = running ? replay.turns.find((t) => t.status === 'pending')?.messageId : null;
  const done = replay.turns.filter((t) => t.status === 'done').length;
  const limit = matchedCaption(replay);
  return (
    <section className="correction-section" aria-labelledby="past-answers">
      <h2 id="past-answers" className="correction-section__title">
        Past answers
      </h2>
      <div className="replay-strip">
        <p>{pastAnswersLede(replay.turns.length)}</p>
        {limit && <p className="field__help">{limit}</p>}
        {pending && running && (
          <div className="replay-strip__progress">
            <div
              className="progress"
              role="progressbar"
              aria-label="Replay progress"
              aria-valuemin={0}
              aria-valuemax={replay.turns.length}
              aria-valuenow={done}
            >
              <div
                className="progress__bar"
                style={{ width: `${(100 * done) / replay.turns.length}%` }}
              />
            </div>
            <span>{correctionProgress(replay.turns)}</span>
          </div>
        )}
        {!pending && <p className="replay-strip__done">{correctionCompleteLine(replay.turns)}</p>}
        {mode === 'rate_limited' && (
          <div className="alert alert--warning" role="alert">
            <p>Replaying quickly. Wait a minute, then continue.</p>
          </div>
        )}
        {pending && (
          <div>
            <Button
              variant={running ? 'ghost' : 'primary'}
              disabled={mode === 'pausing' || (!running && cooling)}
              onClick={running ? onPause : onRun}
            >
              {running ? 'Pause' : 'Continue replay'}
            </Button>
          </div>
        )}
        <div className="sr-only" aria-live="polite">
          {running
            ? correctionProgress(replay.turns)
            : pending
              ? ''
              : correctionCompleteLine(replay.turns)}
        </div>
      </div>
      <ol className="replay-turns">
        {replay.turns.map((t) => (
          <AnswerCompare
            key={t.messageId}
            turn={t}
            label={`Question ${t.index + 1} of ${replay.turns.length}`}
            botName={botName}
            answering={t.messageId === answering}
            failed={mode === 'failed' && t.messageId === failedAt}
            onRetry={onRun}
            asked={dateLabel(t.askedAt)}
            foot={t.answerChanged && <span className="chip chip--accent">Answer changed</span>}
          />
        ))}
      </ol>
    </section>
  );
}

/** The "Edit fix" `form-dialog`: FEAT-011's fields for a fact, question and answer for an FAQ. */
function EditFixDialog({
  open,
  item,
  fact,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  item: CorrectionItem;
  fact: Fact | null;
  busy: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (edit: CorrectionEdit) => void;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={item.change.kind === 'reconfirm' ? 'Edit fact' : 'Edit fix'}
      busy={busy}
    >
      {open && (
        <EditFixForm
          item={item}
          fact={fact}
          busy={busy}
          error={error}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      )}
    </FormDialog>
  );
}

function EditFixForm({
  item,
  fact,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  item: CorrectionItem;
  fact: Fact | null;
  busy: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (edit: CorrectionEdit) => void;
}) {
  const change = item.change;
  const factBase: { type: Fact['type']; base: FactValueView; draft: Draft } | null =
    change.kind === 'edit_fact'
      ? { type: change.factType, base: change.after, draft: draftOf(change.factType, change.after) }
      : change.kind === 'reconfirm' && fact
        ? { type: fact.type, base: viewOf(fact), draft: fromFact(fact) }
        : null;
  const [draft, setDraft] = useState<Draft | null>(factBase?.draft ?? null);
  const [faq, setFaq] = useState(
    change.kind === 'add_faq' ? { question: change.question, answer: change.answer } : null,
  );
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);

  const errors: Partial<Record<FieldName, string>> = draft
    ? validate(draft, factBase?.base.gstTreatment === 'unknown')
    : {
        ...(faq && !faq.question.trim() ? { question: 'Enter the question' } : {}),
        ...(faq && !faq.answer.trim() ? { answer: 'Enter the answer' } : {}),
      };
  const shown = (f: FieldName) => (submitted || touched[f] ? errors[f] : undefined);
  const noop = error instanceof ApiError && error.code === 'invalid_correction';

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    if (draft && factBase) onSubmit(factEdit(draft, factBase.base));
    else if (faq)
      onSubmit({ kind: 'add_faq', question: faq.question.trim(), answer: faq.answer.trim() });
  }

  const was = change.kind === 'edit_fact' ? correctionRows(change).filter((r) => r.was) : [];
  return (
    <form className="fact-form review-edit" onSubmit={submit} noValidate>
      {noop && (
        <div className="alert alert--danger" role="alert">
          <p>This edit doesn't change anything.</p>
        </div>
      )}
      {error && !noop && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't save this just now. Nothing was changed.</p>
        </div>
      )}
      {was.map((r) => (
        <p key={r.label} className="field__help">
          Was {r.label.toLowerCase()}: {r.was}
        </p>
      ))}
      {draft && factBase && (
        <FactFields
          draft={draft}
          set={(patch) => setDraft((d) => (d ? { ...d, ...patch } : d))}
          shown={shown}
          blur={(f) => () => setTouched((t) => ({ ...t, [f]: true }))}
          readOnly={busy}
          fixedType={factBase.type}
        />
      )}
      {faq && (
        <>
          <Field id="fix-question" label="Question" error={shown('question')}>
            <input
              id="fix-question"
              className="input"
              value={faq.question}
              onChange={(e) => setFaq({ ...faq, question: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, question: true }))}
              readOnly={busy}
              aria-invalid={shown('question') ? true : undefined}
              aria-describedby={describedBy('fix-question', shown('question'))}
            />
          </Field>
          <Field id="fix-answer" label="Answer" error={shown('answer')}>
            <textarea
              id="fix-answer"
              className="input input--area"
              value={faq.answer}
              onChange={(e) => setFaq({ ...faq, answer: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, answer: true }))}
              readOnly={busy}
              aria-invalid={shown('answer') ? true : undefined}
              aria-describedby={describedBy('fix-answer', shown('answer'))}
            />
          </Field>
        </>
      )}
      <div className="kaki-dialog__actions">
        <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Accepting…' : 'Accept edited fix'}
        </Button>
      </div>
    </form>
  );
}
