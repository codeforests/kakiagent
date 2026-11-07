import {
  LeadConflict409,
  type LeadConsentRecord,
  type LeadDetail,
  type LeadStatus,
} from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import { dateTime, LEAD_STATUS, STATE_LABEL } from '../lib/inbox.ts';
import {
  leadKey,
  marketingText,
  pointsText,
  reasonText,
  SCORE_LABEL,
  SOURCE_LABEL,
  useLead,
} from '../lib/leads.ts';
import { CopyRow } from './conversation-parts.tsx';
import { ScoreChip, StatusChip, StatusMenu } from './leads-parts.tsx';

/**
 * `/leads/:leadId`: SCR-APP-033 Lead (LED-02, LED-03, LED-05, LED-08; FEAT-050 ui-design).
 * Every member reads it; Owner and Admin move its status (D4, compare-and-set on `version`).
 */
export function LeadPage() {
  const { leadId = '' } = useParams();
  const location = useLocation();
  const back = (location.state as { back?: string } | null)?.back ?? '';
  const lead = useLead(leadId);
  const notFound =
    lead.error instanceof ApiError && (lead.error.status === 404 || lead.error.status === 400);

  return (
    <div className="lead-page">
      <Link className="back-link" to={`/leads${back}`}>
        Leads
      </Link>
      {lead.isPending && (
        <div className="lead-page__grid" aria-busy="true" aria-label="Loading lead">
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
        </div>
      )}
      {notFound && (
        <EmptyState
          title="This lead doesn't exist or was deleted"
          action={<Link to="/leads">Back to leads</Link>}
        />
      )}
      {lead.isError && !notFound && (
        <ErrorState
          title="Couldn't load this lead"
          action={
            <Button variant="secondary" onClick={() => void lead.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {lead.data && <LeadBody lead={lead.data} />}
    </div>
  );
}

type Conflict = { kind: 'stale'; status: LeadStatus } | { kind: 'open_lead_exists' };

function LeadBody({ lead }: { lead: LeadDetail }) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useToast();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (conflict) alertRef.current?.focus();
  }, [conflict]);

  const move = useMutation({
    mutationFn: (status: LeadStatus) =>
      api.setLeadStatus(lead.id, { status, version: lead.version }),
    onMutate: () => setConflict(null),
    onSuccess: (row) => {
      queryClient.setQueryData<LeadDetail>(leadKey(lead.id), (d) => (d ? { ...d, ...row } : d));
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      setToast(`Marked as ${LEAD_STATUS[row.status].label}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const body = LeadConflict409.safeParse({ ...err.details, error: err.code });
        if (body.success && body.data.error === 'stale' && body.data.lead) {
          const row = body.data.lead;
          queryClient.setQueryData<LeadDetail>(leadKey(lead.id), (d) => (d ? { ...d, ...row } : d));
          void queryClient.invalidateQueries({ queryKey: ['leads'] });
          return setConflict({ kind: 'stale', status: row.status });
        }
        if (err.code === 'open_lead_exists') return setConflict({ kind: 'open_lead_exists' });
        void queryClient.invalidateQueries({ queryKey: leadKey(lead.id) });
        return setToast("Couldn't save. Try again.");
      }
      setToast(
        err instanceof ApiError && err.status === 403
          ? "You can't change leads."
          : "Couldn't save. Try again.",
      );
    },
  });

  const scoring = lead.scoring;
  return (
    <>
      <div className="page-header lead-page__header">
        <h1 className="page-title">{lead.name || 'No name given'}</h1>
        <div className="lead-page__chips">
          <ScoreChip scoring={scoring} />
          <StatusChip status={lead.status} />
          {lead.canManage && (
            <StatusMenu
              status={lead.status}
              busy={move.isPending}
              onChange={(s) => move.mutate(s)}
            />
          )}
        </div>
      </div>
      {conflict && (
        <div className="alert alert--warning" role="alert" tabIndex={-1} ref={alertRef}>
          <p>
            {conflict.kind === 'stale'
              ? `Someone else changed this lead. It's now ${LEAD_STATUS[conflict.status].label}.`
              : 'This person already has an open lead. Close that one first.'}
          </p>
        </div>
      )}
      <div className="lead-page__grid">
        <div className="stack lead-page__main">
          <section className="card stack" aria-labelledby="lead-details-title">
            <h2 className="section-title" id="lead-details-title">
              Details
            </h2>
            <dl className="lead-fields">
              <div>
                <dt>Phone</dt>
                <dd>{lead.phone ? <CopyRow label="phone" value={lead.phone} /> : <NotGiven />}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{lead.email ? <CopyRow label="email" value={lead.email} /> : <NotGiven />}</dd>
              </div>
              <div>
                <dt>What they need</dt>
                <dd className="lead-fields__need">{lead.need || <NotGiven />}</dd>
              </div>
              <div>
                <dt>Budget</dt>
                <dd>{lead.budget || <NotGiven />}</dd>
              </div>
              <div>
                <dt>Preferred date or time</dt>
                <dd>{lead.preferredTime || <NotGiven />}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{SOURCE_LABEL[lead.source]}</dd>
              </div>
              <div>
                <dt>Offers</dt>
                <dd>{marketingText(lead.marketing).replace(/^Offers: /, '')}</dd>
              </div>
            </dl>
            <p className="lead-fields__caption">
              {lead.captures > 1 && <>Left details {lead.captures} times · </>}
              First captured {dateTime(lead.createdAt)} · Updated {dateTime(lead.updatedAt)}
            </p>
          </section>
          <section
            className="card stack"
            aria-labelledby="lead-score-title"
            data-testid="lead-score"
          >
            <h2 className="section-title" id="lead-score-title">
              {scoring
                ? `Score: ${SCORE_LABEL[scoring.score]} · ${scoring.points} points`
                : 'Score'}
            </h2>
            {scoring ? (
              <ul className="lead-reasons">
                {scoring.reasons.map((r, i) => (
                  <li key={`${r.code}-${i}`}>
                    {reasonText(r)}{' '}
                    <span className="lead-reasons__points">{pointsText(r.points)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                Not scored yet. It's scored the next time they leave details or when you save lead
                settings.
              </p>
            )}
            <p className="lead-fields__caption">
              Hot is 5 points or more, warm 3 to 4.{' '}
              {lead.canManage ? (
                <>
                  Change what counts on{' '}
                  <Link to="/settings/leads#qualification">Lead settings</Link>.
                </>
              ) : (
                'Change what counts on Lead settings.'
              )}
            </p>
          </section>
        </div>
        <div className="stack lead-page__aside">
          <section className="card stack" aria-labelledby="lead-consent-title">
            <h2 className="section-title" id="lead-consent-title">
              Consent
            </h2>
            {lead.consents.length === 0 ? (
              <p className="lead-fields__caption">No consent records.</p>
            ) : (
              <ul className="lead-consents" data-testid="lead-consents">
                {lead.consents.map((c) => (
                  <ConsentEntry key={c.id} c={c} />
                ))}
              </ul>
            )}
          </section>
          <section className="card stack" aria-labelledby="lead-conversations-title">
            <h2 className="section-title" id="lead-conversations-title">
              Conversations
            </h2>
            {lead.conversations.length === 0 ? (
              <p className="lead-fields__caption">Left on the contact form, no conversation.</p>
            ) : (
              <ul className="lead-conversations">
                {lead.conversations.map((c) => (
                  <li key={c.id}>
                    <Link to={`/inbox/${c.id}`}>
                      {dateTime(c.startedAt).split(',')[0]} · {STATE_LABEL[c.status]}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

const NotGiven = () => <span className="lead-fields__empty">Not given</span>;

const CONSENT_TEXT = {
  enquiry: { agreed: 'Agreed to be contacted', declined: 'Chose not to share details' },
  marketing: { agreed: 'Agreed to offers', declined: 'Declined offers' },
} as const;

function ConsentEntry({ c }: { c: LeadConsentRecord }) {
  return (
    <li className="lead-consent" data-testid="lead-consent">
      <p className="lead-consent__what">{CONSENT_TEXT[c.purpose][c.decision]}</p>
      <p className="lead-fields__caption">
        {dateTime(c.at)} · {c.conversationId ? 'Website chat' : 'Contact form'}
      </p>
      <details className="lead-consent__wording">
        <summary>Wording shown (version {c.wording.version})</summary>
        <p>{c.wording.text}</p>
      </details>
    </li>
  );
}
