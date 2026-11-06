import { AlreadyDecided, type ApprovalDecision, type ApprovalDetail } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import {
  approvalKey,
  decidedToast,
  decisionText,
  headingOf,
  slaChip,
  STATUS_LABEL,
  timeOf,
  useApproval,
} from '../lib/approvals.ts';
import { useToast } from '../lib/form.ts';
import {
  DraftEditor,
  ExcerptCard,
  PricesCard,
  QuotePreview,
  RejectDialog,
  RequestCard,
} from './approval-parts.tsx';
import { useNow } from './approvals.tsx';

/**
 * `/approvals/:id`: SCR-APP-018 Approval (APR-02, APR-06; FEAT-055 ui-design). Approve the
 * draft, edit then approve, or reject with a reason. A second decider gets 409 with the row
 * and sees who decided first; an Agent without rights sees the actions disabled (D8).
 */
export function ApprovalPage() {
  const { id = '' } = useParams();
  const approval = useApproval(id);
  const notFound =
    approval.error instanceof ApiError &&
    (approval.error.status === 404 || approval.error.status === 400);

  return (
    <div className="approval-page">
      <Link className="back-link" to="/approvals">
        Approvals
      </Link>
      {approval.isPending && (
        <div aria-busy="true" aria-label="Loading approval">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}
      {notFound && (
        <EmptyState
          title="This approval doesn't exist or isn't in this business"
          action={<Link to="/approvals">Back to approvals</Link>}
        />
      )}
      {approval.isError && !notFound && (
        <ErrorState
          title="Couldn't load this approval"
          action={
            <Button variant="secondary" onClick={() => void approval.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {approval.data && <ApprovalBody a={approval.data} />}
    </div>
  );
}

function ApprovalBody({ a }: { a: ApprovalDetail }) {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const meId = me.data?.user.id ?? null;
  const now = useNow();
  const [toast, setToast] = useToast();
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [action, setAction] = useState<ApprovalDecision['action'] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const [focusAlert, setFocusAlert] = useState(0);
  // Seen pending, then decided by someone else (live or 409): move focus to the alert.
  const wasPending = useRef(a.status === 'pending');

  useEffect(() => {
    if (a.status !== 'pending' && wasPending.current) {
      wasPending.current = false;
      if (a.decision?.by?.userId !== meId) {
        setEditing(false);
        setRejecting(false);
        setFocusAlert((k) => k + 1);
      }
    }
  }, [a.status, a.decision, meId]);
  useEffect(() => {
    if (focusAlert) alertRef.current?.focus();
  }, [focusAlert]);

  const decide = useMutation({
    mutationFn: (body: ApprovalDecision) => api.decideApproval(a.id, body),
    onMutate: (body) => {
      setAction(body.action);
      setFailure(null);
    },
    onSuccess: (res, body) => {
      wasPending.current = false;
      queryClient.setQueryData(approvalKey(a.id), res);
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      setEditing(false);
      setRejecting(false);
      setToast(decidedToast(body.action));
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const body = AlreadyDecided.safeParse({ error: err.code, ...err.details });
        if (body.success) queryClient.setQueryData(approvalKey(a.id), body.data.approval);
        else void queryClient.invalidateQueries({ queryKey: approvalKey(a.id) });
        void queryClient.invalidateQueries({ queryKey: ['approvals'] });
        return;
      }
      setFailure(
        err instanceof ApiError && err.status === 422
          ? "Those terms couldn't be sent. Check the lines and the discount."
          : err instanceof ApiError && err.status === 403
            ? 'You can see approvals but not decide them. Ask the Owner for approval rights.'
            : "Couldn't send your decision. Nothing was changed. Try again.",
      );
    },
    onSettled: () => setAction(null),
  });

  const pending = a.status === 'pending';
  const busy = decide.isPending;
  const sla = pending ? slaChip(a, now) : null;
  const decided = decisionText(a, meId);
  const terms = a.final ?? a.draft;
  const totals = a.finalTotals ?? a.draftTotals;
  const alertTone =
    a.status === 'undeliverable' ? 'danger' : a.status === 'expired' ? 'neutral' : 'info';

  return (
    <>
      <header className="approval-header">
        <h1 className="page-title">{headingOf(a)}</h1>
        <p className="approval-header__meta">
          Asked {timeOf(a.createdAt)} · <Link to={`/inbox/${a.conversationId}`}>Conversation</Link>
          {sla && <span className={`chip chip--${sla.tone}`}>{sla.text}</span>}
          {!pending && (
            <span className={`chip chip--${STATUS_LABEL[a.status].tone}`}>
              {STATUS_LABEL[a.status].label}
            </span>
          )}
        </p>
      </header>
      {decided && (
        <div
          className={`alert alert--${alertTone}`}
          role="alert"
          tabIndex={-1}
          ref={alertRef}
          data-testid="approval-decided"
        >
          <p>{decided}</p>
          {a.status === 'rejected' && a.decision?.reason && (
            <p>Reason (only your team sees this): {a.decision.reason}</p>
          )}
          {a.status === 'undeliverable' && (
            <Link to={`/inbox/${a.conversationId}`}>Open conversation</Link>
          )}
        </div>
      )}
      <div className="approval-columns">
        <div className="approval-columns__main">
          <section className="card approval-card" aria-labelledby="ap-draft">
            <h2 id="ap-draft" className="section-title">
              {pending ? 'Draft' : 'Sent to the visitor'}
            </h2>
            {failure && (
              <div className="alert alert--danger" role="alert">
                <p>{failure}</p>
              </div>
            )}
            {pending && a.draft.lines.length === 0 && !editing && (
              <div className="alert alert--info">
                <p>Your assistant couldn't match a price. Edit to add one.</p>
              </div>
            )}
            {editing && pending ? (
              <DraftEditor
                a={a}
                busy={busy}
                onCancel={() => setEditing(false)}
                onSubmit={(t) =>
                  decide.mutate({ action: 'edit_approve', version: a.version, terms: t })
                }
              />
            ) : (
              <QuotePreview terms={terms} totals={totals} />
            )}
            {pending && !editing && a.status !== 'expired' && (
              <div className="approval-actions approval-actions--sticky">
                <Button
                  onClick={() => decide.mutate({ action: 'approve', version: a.version })}
                  disabled={
                    busy || !a.canDecide || (a.draft.lines.length === 0 && !a.draft.note.trim())
                  }
                  aria-busy={action === 'approve' || undefined}
                  title={a.canDecide ? undefined : 'Ask the Owner for approval rights'}
                >
                  {action === 'approve' ? 'Sending…' : 'Approve and send'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setEditing(true)}
                  disabled={busy || !a.canDecide}
                  title={a.canDecide ? undefined : 'Ask the Owner for approval rights'}
                >
                  Edit
                </Button>
                <Button
                  variant="danger-ghost"
                  onClick={() => setRejecting(true)}
                  disabled={busy || !a.canDecide}
                  title={a.canDecide ? undefined : 'Ask the Owner for approval rights'}
                >
                  Reject
                </Button>
              </div>
            )}
          </section>
          <RequestCard a={a} />
        </div>
        <div className="approval-columns__side">
          <PricesCard a={a} />
          <ExcerptCard a={a} />
        </div>
      </div>
      <RejectDialog
        open={rejecting && pending}
        onOpenChange={setRejecting}
        busy={action === 'reject'}
        onReject={(reason) => decide.mutate({ action: 'reject', version: a.version, reason })}
      />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
