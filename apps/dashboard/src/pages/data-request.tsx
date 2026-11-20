import type { DsrDetail, DsrEraseResult, DsrFindResult } from '@kaki/contracts';
import { Button, EmptyState, ErrorState, MetaGrid } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import {
  dsrDay,
  dsrErrorText,
  dsrKey,
  findKey,
  historyText,
  recoveryOf,
  requesterLabel,
  selectionFrom,
  TYPE_LABEL,
  useDataRequest,
  useDsrFind,
  type Picked,
} from '../lib/data-requests.ts';
import { useToast } from '../lib/form.ts';
import { dateTime } from '../lib/inbox.ts';
import {
  ActCard,
  CloseDialog,
  DoneCard,
  FindCard,
  VerifyCard,
  type PageAlert,
} from './data-request-act.tsx';
import { Breadcrumb, DueChip, RequestFormDialog, StatusChip } from './data-request-parts.tsx';

/**
 * `/settings/privacy/requests/:id`: SCR-APP-049 Data request (GOV-05, UC-30; FEAT-061
 * ui-design), Owner and Admin. Verify → find → act (export, correct or delete) → done. No live
 * updates: it refetches on window focus, and every 10 s while the files are being removed.
 */
export function DataRequestPage() {
  const { id = '' } = useParams();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const allowed = me.data ? me.data.role === 'owner' || me.data.role === 'admin' : undefined;
  const detail = useDataRequest(id);
  const forbidden =
    allowed === false || (detail.error instanceof ApiError && detail.error.status === 403);
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;

  if (forbidden)
    return (
      <div className="dsr-page">
        <Breadcrumb current="Data request" request />
        <h1 className="page-title">Data request</h1>
        <EmptyState title="You don't have access to this page">
          Only the Owner and Admins can handle data requests.
        </EmptyState>
      </div>
    );
  return (
    <div className="dsr-page">
      {detail.isPending && (
        <div className="dsr-grid" aria-busy="true" aria-label="Loading data request">
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
        </div>
      )}
      {notFound && (
        <>
          <Breadcrumb current="Not found" request />
          <EmptyState
            title="This request doesn't exist."
            action={<Link to="/settings/privacy/requests">Back to data requests</Link>}
          />
        </>
      )}
      {detail.isError && !notFound && (
        <ErrorState
          title="Couldn't load this request"
          action={
            <Button variant="secondary" onClick={() => void detail.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {detail.data && <RequestBody d={detail.data} />}
    </div>
  );
}

function RequestBody({ d }: { d: DsrDetail }) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useToast();
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [alert, setAlert] = useState<PageAlert | null>(null);
  const [erased, setErased] = useState<DsrEraseResult | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (alert) alertRef.current?.focus();
  }, [alert]);

  const searchable = d.status === 'open' || d.status === 'verified';
  const find = useDsrFind(d.id, searchable);
  const [picked, setPicked] = useState<Picked | null>(null);
  // The default selection, once per result (a new search resets it).
  const [pickedFor, setPickedFor] = useState<DsrFindResult | undefined>(undefined);
  if (find.data && find.data !== pickedFor) {
    setPickedFor(find.data);
    setPicked(selectionFrom(find.data));
  }

  const update = (next: DsrDetail) => {
    queryClient.setQueryData(dsrKey(d.id), next);
    void queryClient.invalidateQueries({ queryKey: ['data-requests'] });
  };
  const fail = (err: unknown): boolean => {
    const recovery = recoveryOf(err);
    if (!recovery) return false;
    setAlert({ text: dsrErrorText(err), recovery });
    return true;
  };
  const reload = () => {
    setAlert(null);
    void queryClient.invalidateQueries({ queryKey: dsrKey(d.id) });
  };
  const searchAgain = () => {
    setAlert(null);
    void queryClient.invalidateQueries({ queryKey: findKey(d.id) });
  };
  const ctx = { d, update, fail, setToast };

  const close = useMutation({
    mutationFn: (reason: string) =>
      api.dataRequestAction(d.id, 'close', { version: d.version, reason }),
    onSuccess: (next) => {
      update(next);
      setClosing(false);
      setToast('Request closed.');
    },
    onError: (err) => {
      if (fail(err)) setClosing(false);
    },
  });

  const loggedBy = [...d.events].reverse().find((e) => e.code === 'dsr.opened')?.by ?? null;
  const done = d.status === 'completed' && d.type === 'deletion';

  return (
    <>
      <Breadcrumb current={d.ref} request />
      <div className="page-header dsr-header">
        <div className="page-header__text">
          <h1 className="page-title">{TYPE_LABEL[d.type]} request</h1>
          <p className="dsr-header__chips">
            <span className="dsr-ref">{d.ref}</span> <StatusChip status={d.status} />{' '}
            <DueChip r={d} />
          </p>
          <p className="dsr-caption">
            Received {dsrDay(d.receivedOn)} ·{' '}
            {d.source === 'conversation' && d.conversationId ? (
              <Link to={`/inbox/${d.conversationId}`}>From a chat</Link>
            ) : (
              `Logged by ${loggedBy ?? 'a team member'}`
            )}
          </p>
        </div>
      </div>
      {alert && (
        <div className="alert alert--danger" role="alert" tabIndex={-1} ref={alertRef}>
          <p>{alert.text}</p>
          <Button variant="secondary" onClick={alert.recovery === 'reload' ? reload : searchAgain}>
            {alert.recovery === 'reload' ? 'Reload' : 'Search again'}
          </Button>
        </div>
      )}
      <div className="dsr-grid">
        <div className="dsr-main stack">
          {done && <DoneCard d={d} erased={erased} />}
          {d.status === 'unverified' && d.closed && (
            <div className="alert alert--danger">
              <p>
                Closed as not verified on {dsrDay(d.closed.at)}
                {d.closed.by ? ` by ${d.closed.by}` : ''}: {d.closed.reason}
              </p>
            </div>
          )}
          {d.status === 'closed' && d.closed && (
            <div className="alert alert--info">
              <p>
                Closed without action on {dsrDay(d.closed.at)}
                {d.closed.by ? ` by ${d.closed.by}` : ''}: {d.closed.reason}
              </p>
            </div>
          )}
          {d.status === 'completed' && d.type !== 'deletion' && d.closed && (
            <div className="alert alert--success" data-testid="dsr-completed">
              <p>
                Completed on {dsrDay(d.closed.at)}
                {d.closed.by ? ` by ${d.closed.by}` : ''}.
                {d.closed.reason ? ` ${d.closed.reason}` : ''}
              </p>
            </div>
          )}
          <VerifyCard {...ctx} />
          {searchable && (
            <FindCard
              {...ctx}
              find={find}
              picked={picked}
              onPick={setPicked}
              onEditSearch={() => setEditing(true)}
            />
          )}
          {d.status === 'verified' && find.data && picked && (
            <ActCard {...ctx} find={find.data} picked={picked} onErased={setErased} />
          )}
          {searchable && (
            <p>
              <Button variant="ghost" onClick={() => setClosing(true)}>
                Close without action
              </Button>
            </p>
          )}
        </div>
        <aside className="dsr-aside stack" aria-label="Request details and history">
          <section className="card stack" aria-labelledby="dsr-details-title">
            <div className="dsr-card-head">
              <h2 className="section-title" id="dsr-details-title">
                Request details
              </h2>
              {d.status === 'open' && (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </div>
            <MetaGrid
              className="dsr-meta"
              items={[
                {
                  label: 'Requester',
                  value: (
                    <>
                      {requesterLabel(d.requester)}
                      {d.requester.erased && (
                        <span className="dsr-caption"> Details masked after deletion</span>
                      )}
                    </>
                  ),
                  testId: 'dsr-requester',
                },
                { label: 'Received', value: dsrDay(d.receivedOn) },
                { label: 'Due', value: dsrDay(d.dueOn) },
                { label: 'Note', value: d.note ?? '—' },
              ]}
            />
          </section>
          <section className="card stack" aria-labelledby="dsr-history-title">
            <h2 className="section-title" id="dsr-history-title">
              History
            </h2>
            {d.events.length === 0 ? (
              <p className="dsr-caption">Nothing yet.</p>
            ) : (
              <ol className="dsr-history" data-testid="dsr-history">
                {d.events.map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    <span className="dsr-history__what">{historyText(e.code)}</span>
                    <span className="dsr-caption">
                      {e.by ?? 'KakiAgent'} · {dateTime(e.at)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
      <RequestFormDialog
        open={editing}
        onOpenChange={setEditing}
        detail={d}
        onSaved={() => {
          setEditing(false);
          setToast('Request updated.');
        }}
      />
      <CloseDialog
        open={closing}
        onOpenChange={setClosing}
        title="Close without action?"
        body="The request is closed and nothing is changed. Say why, for the record."
        confirmLabel="Close request"
        busy={close.isPending}
        error={close.isError && !recoveryOf(close.error) ? dsrErrorText(close.error) : null}
        quickReasons={['Duplicate', 'They withdrew the request']}
        onConfirm={(reason) => close.mutate(reason)}
      />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
