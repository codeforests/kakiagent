import type { CoverageGap, CoverageReport, CoverageTopic } from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState, ErrorState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useCorrectionsChanged } from '../lib/corrections.ts';
import {
  allClear,
  allTopicsLine,
  askedLine,
  GAP_REASON,
  gapCaption,
  sectionOrder,
  summaryLines,
  TOPIC_STATE,
  topicsDone,
  useCoverage,
} from '../lib/coverage.ts';
import { useToast } from '../lib/form.ts';
import { INDUSTRY_LABEL } from './business-profile.tsx';
import { AddFaqDialog, type FaqAnswer } from './faq-dialog.tsx';
import { KnowledgeTabs } from './knowledge-tabs.tsx';

type Answering = { kind: 'topic'; topic: CoverageTopic } | { kind: 'gap'; gap: CoverageGap };

const SAVED = 'Saved. Your assistant uses this answer now.';
const SAVE_FAILED = "We couldn't save this just now. Nothing was changed.";
const isClosed = (err: unknown) => err instanceof ApiError && err.code === 'correction_closed';

/** SCR-APP-029 Coverage at `/knowledge/coverage` (KB-09, UC-16 3b; FEAT-019 ui-design). */
export function CoveragePage() {
  const queryClient = useQueryClient();
  const report = useCoverage();
  const correctionsChanged = useCorrectionsChanged();
  const [toast, setToast] = useToast();
  const [answering, setAnswering] = useState<Answering | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CoverageGap | null>(null);
  const [handled, setHandled] = useState(false);
  const focusId = useRef<string | null>(null);

  // Focus moves once the row it names (or the section heading) is rendered.
  useEffect(() => {
    const el = focusId.current && document.getElementById(focusId.current);
    if (el) {
      el.focus();
      focusId.current = null;
    }
  });
  const setFocusId = (id: string) => {
    focusId.current = id;
  };

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['coverage'] });
  const setReport = (fn: (r: CoverageReport) => CoverageReport) =>
    queryClient.setQueryData(['coverage'], (old: CoverageReport | undefined) =>
      old ? fn(old) : old,
    );

  /** Drops a gap from the list and moves focus to the next row, or the heading. */
  const gapLeft = (gap: CoverageGap) => {
    const gaps = report.data?.gaps ?? [];
    const i = gaps.findIndex((g) => g.correctionId === gap.correctionId);
    const next = gaps[i + 1] ?? gaps[i - 1];
    setFocusId(next ? `gap-add-${next.correctionId}` : 'coverage-gaps');
    setReport((r) => ({
      ...r,
      gaps: r.gaps.filter((g) => g.correctionId !== gap.correctionId),
      summary: { ...r.summary, openGaps: Math.max(0, r.summary.openGaps - 1) },
    }));
    refresh();
    correctionsChanged();
  };
  const onHandled = () => {
    setHandled(true);
    refresh();
    correctionsChanged();
  };

  const save = useMutation({
    mutationFn: async ({ target, faq }: { target: Answering; faq: FaqAnswer }) => {
      if (target.kind === 'topic') await api.createFact({ type: 'faq', value: faq });
      else
        await api.acceptCorrection(target.gap.correctionId, {
          kind: 'add_faq',
          question: faq.question,
          answer: faq.answer,
        });
    },
    onSuccess: (_, { target }) => {
      setAnswering(null);
      setToast(SAVED);
      void queryClient.invalidateQueries({ queryKey: ['facts'] });
      if (target.kind === 'gap') gapLeft(target.gap);
      else {
        setFocusId(`topic-state-${target.topic.id}`);
        refresh();
      }
    },
    onError: (err) => {
      if (isClosed(err)) {
        setAnswering(null);
        onHandled();
      } else setSaveError(SAVE_FAILED);
    },
  });
  const close = useMutation({
    mutationFn: (gap: CoverageGap) => api.closeCorrection(gap.correctionId),
    onSuccess: (_, gap) => {
      setRemoving(null);
      setToast('Removed.');
      gapLeft(gap);
    },
    onError: (err) => {
      setRemoving(null);
      if (isClosed(err)) onHandled();
      else setToast("Couldn't remove this just now.");
    },
  });
  const skip = useMutation({
    mutationFn: ({ topic, skipped }: { topic: CoverageTopic; skipped: boolean }) =>
      api.setCoverageTopic(topic.id, skipped),
    onSuccess: (res, { skipped }) => {
      setReport((r) =>
        r.template
          ? {
              ...r,
              template: {
                ...r.template,
                topics: r.template.topics.map((t) => (t.id === res.topic.id ? res.topic : t)),
              },
            }
          : r,
      );
      if (skipped) setToast('Marked as not applying to your business.');
      setFocusId(skipped ? `topic-undo-${res.topic.id}` : `topic-add-${res.topic.id}`);
      refresh();
    },
    onError: () => setToast("Couldn't change this just now."),
  });

  const answer = (target: Answering) => {
    save.reset();
    setSaveError(null);
    setAnswering(target);
  };

  const err = report.error;
  if (err instanceof ApiError && err.status === 403)
    return (
      <div className="coverage">
        <h1 className="page-title">Knowledge</h1>
        <KnowledgeTabs />
        <EmptyState title="You can't see coverage">
          Only the Owner and Admins can see coverage.
        </EmptyState>
      </div>
    );

  const data = report.data;
  return (
    <div className="coverage">
      <h1 className="page-title">Knowledge</h1>
      <KnowledgeTabs />
      <div className="page-header coverage__head">
        <div className="page-header__text">
          <h2 className="section-title">Coverage</h2>
          <p className="page-lede">
            Questions customers often ask that your assistant can't answer yet. Add an answer and it
            starts using it right away.
          </p>
        </div>
      </div>

      {report.isPending && (
        <div aria-busy="true" aria-label="Loading coverage">
          <div className="skeleton-field coverage__summary-skeleton" />
          <ul className="source-list">
            {Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="skeleton-row" />
            ))}
          </ul>
        </div>
      )}
      {report.isError && (
        <ErrorState
          title="Couldn't load coverage."
          action={
            <Button variant="secondary" onClick={() => void report.refetch()}>
              Try again
            </Button>
          }
        />
      )}

      {data && (
        <>
          {handled && (
            <div className="alert alert--warning" role="alert">
              <p>This was already handled.</p>
            </div>
          )}
          {allClear(data) ? (
            <EmptyState title="Your assistant can answer everything customers have asked so far." />
          ) : (
            <div className="coverage__summary">
              {summaryLines(data).map((line) => (
                <p key={line} className="coverage__summary-line">
                  {line}
                </p>
              ))}
            </div>
          )}
          {sectionOrder(data).map((section) =>
            section === 'gaps' ? (
              allClear(data) ? null : (
                <GapsSection
                  key="gaps"
                  report={data}
                  busy={close.isPending || save.isPending}
                  onAnswer={(gap) => answer({ kind: 'gap', gap })}
                  onRemove={setRemoving}
                />
              )
            ) : (
              <TopicsSection
                key="topics"
                report={data}
                busy={skip.isPending}
                onAnswer={(topic) => answer({ kind: 'topic', topic })}
                onSkip={(topic, skipped) => skip.mutate({ topic, skipped })}
                onRetry={() => void report.refetch()}
              />
            ),
          )}
        </>
      )}

      <AddFaqDialog
        open={answering !== null}
        question={
          answering?.kind === 'topic' ? answering.topic.question : (answering?.gap.question ?? '')
        }
        help={answering?.kind === 'topic' ? answering.topic.hint : undefined}
        caption={answering?.kind === 'gap' ? gapCaption(answering.gap.asksTotal) : undefined}
        busy={save.isPending}
        error={saveError}
        onClose={() => setAnswering(null)}
        onSubmit={(faq) => {
          if (!answering) return;
          setSaveError(null);
          save.mutate({ target: answering, faq });
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this from coverage?"
        confirmLabel="Remove"
        onConfirm={() => removing && close.mutate(removing)}
        busy={close.isPending}
      >
        Your knowledge doesn't change, and it closes the item in Corrections.
      </ConfirmDialog>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function GapsSection({
  report,
  busy,
  onAnswer,
  onRemove,
}: {
  report: CoverageReport;
  busy: boolean;
  onAnswer: (gap: CoverageGap) => void;
  onRemove: (gap: CoverageGap) => void;
}) {
  return (
    <section className="coverage__section" aria-labelledby="coverage-gaps">
      <h2 id="coverage-gaps" className="section-title" tabIndex={-1}>
        Questions from customers
      </h2>
      {report.gaps.length === 0 ? (
        <p className="field__help">
          {report.stage === 'pre_live'
            ? "Once customers start chatting, questions your assistant couldn't answer appear here."
            : 'No unanswered customer questions right now.'}
        </p>
      ) : (
        <ul className="source-list" data-testid="coverage-gaps">
          {report.gaps.map((g) => (
            <li key={g.correctionId} className="source-row coverage-row" data-testid="gap-row">
              <div className="coverage-row__main">
                <p className="coverage-row__question coverage-row__question--quoted">
                  “{g.question}”
                </p>
                <p className="source-row__meta">{askedLine(g)}</p>
                <div className="correction-row__chips">
                  {g.reasons.map((r) => (
                    <span key={r} className="chip chip--neutral">
                      {GAP_REASON[r]}
                    </span>
                  ))}
                </div>
              </div>
              <div className="coverage-row__actions">
                <Button
                  id={`gap-add-${g.correctionId}`}
                  onClick={() => onAnswer(g)}
                  disabled={busy}
                  aria-label={`Add an answer: ${g.question}`}
                >
                  Add an answer
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => onRemove(g)}
                  disabled={busy}
                  aria-label={`Not something to answer: ${g.question}`}
                >
                  Not something to answer
                </Button>
                <Button variant="ghost" asChild>
                  <Link
                    to={`/review/corrections/${g.correctionId}`}
                    aria-label={`Details: ${g.question}`}
                  >
                    Details
                  </Link>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TopicsSection({
  report,
  busy,
  onAnswer,
  onSkip,
  onRetry,
}: {
  report: CoverageReport;
  busy: boolean;
  onAnswer: (topic: CoverageTopic) => void;
  onSkip: (topic: CoverageTopic, skipped: boolean) => void;
  onRetry: () => void;
}) {
  const template = report.template;
  const profile = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => api.businessProfile(),
    enabled: !template,
    retry: false,
  });
  const industry = template ? INDUSTRY_LABEL[template.industry] : undefined;

  const list = template && (
    <ul className="source-list" data-testid="coverage-topics">
      {template.topics.map((t) => (
        <TopicRow key={t.id} topic={t} busy={busy} onAnswer={onAnswer} onSkip={onSkip} />
      ))}
    </ul>
  );
  return (
    <section className="coverage__section" aria-labelledby="coverage-topics">
      <h2 id="coverage-topics" className="section-title" tabIndex={-1}>
        {industry ? `Common questions for ${industry.toLowerCase()}` : 'Common questions'}
      </h2>
      {!template ? (
        <EmptyState
          title="No common questions for your industry yet."
          action={
            profile.data && !profile.data.profile.industry ? (
              <Link to="/settings/business-profile">Set your industry</Link>
            ) : undefined
          }
        />
      ) : (
        <>
          {template.checked === 'question_only' && (
            <div className="alert alert--info" role="status">
              <p>
                We couldn't check your answers by meaning just now, so only exact questions are
                matched. Some may already be answered.
              </p>
              <Button variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            </div>
          )}
          {report.stage === 'live' && topicsDone(report) ? (
            <>
              <p className="field__help">{allTopicsLine(template.topics)}</p>
              <details className="coverage__more">
                <summary>Show them</summary>
                {list}
              </details>
            </>
          ) : (
            list
          )}
        </>
      )}
    </section>
  );
}

function TopicRow({
  topic: t,
  busy,
  onAnswer,
  onSkip,
}: {
  topic: CoverageTopic;
  busy: boolean;
  onAnswer: (topic: CoverageTopic) => void;
  onSkip: (topic: CoverageTopic, skipped: boolean) => void;
}) {
  const state = TOPIC_STATE[t.state];
  return (
    <li className="source-row coverage-row" data-testid="topic-row">
      <div className="coverage-row__main">
        <p className="coverage-row__question">{t.question}</p>
        <p className="source-row__meta">{t.hint}</p>
        <div className="correction-row__chips">
          <span
            id={`topic-state-${t.id}`}
            className={`chip chip--${state.tone}`}
            tabIndex={-1}
            data-testid="topic-state"
          >
            {t.state === 'covered' && <span aria-hidden="true">✓ </span>}
            {state.label}
          </span>
        </div>
        {t.coveredBy && (
          <p className="source-row__meta">
            Answered by{' '}
            <Link to={`/knowledge/facts/${t.coveredBy.factId}`}>{t.coveredBy.label}</Link>
          </p>
        )}
      </div>
      <div className="coverage-row__actions">
        {t.state === 'missing' && (
          <>
            <Button
              id={`topic-add-${t.id}`}
              onClick={() => onAnswer(t)}
              disabled={busy}
              aria-label={`Add an answer: ${t.question}`}
            >
              Add an answer
            </Button>
            <Button
              variant="ghost"
              onClick={() => onSkip(t, true)}
              disabled={busy}
              aria-label={`Doesn't apply: ${t.question}`}
            >
              Doesn't apply
            </Button>
          </>
        )}
        {t.state === 'skipped' && (
          <Button
            id={`topic-undo-${t.id}`}
            variant="ghost"
            onClick={() => onSkip(t, false)}
            disabled={busy}
            aria-label={`Undo: ${t.question}`}
          >
            Undo
          </Button>
        )}
      </div>
    </li>
  );
}
