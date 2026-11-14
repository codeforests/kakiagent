import {
  LeadStatus,
  type LeadConsentRecord,
  type LeadDetail,
  type LeadMarketing,
  type WithdrawScope,
} from '@kaki/contracts';
import { ConfirmDialog } from '@kaki/ui';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type RefObject } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { dateTime, LEAD_STATUS } from '../lib/inbox.ts';
import {
  consentWhere,
  csvLeadCount,
  exportFileName,
  filterNote,
  leadKey,
  marketingText,
  offersWithdrawable,
  type LeadsFilter,
} from '../lib/leads.ts';
import { ReauthCancelled, useReauthGuard } from '../lib/reauth.ts';
import { Glyph, ScoreChip } from './conversation-parts.tsx';

/** The parts of SCR-APP-032 Leads and SCR-APP-033 Lead (FEAT-050 ui-design, "Shared words"). */

// The score chip lives with the inbox sidebar's parts, which show it too.
export { ScoreChip };

export function StatusChip({ status }: { status: LeadStatus }) {
  return (
    <span className={`chip chip--${LEAD_STATUS[status].tone}`} data-testid="status-chip">
      {LEAD_STATUS[status].label}
    </span>
  );
}

/**
 * "Status: New" with the four statuses as `menuitemradio` (Owner and Admin). Choosing one
 * saves at once; not optimistic, so the button reads "Saving…" until the server answers.
 */
export function StatusMenu({
  status,
  busy,
  onChange,
}: {
  status: LeadStatus;
  busy: boolean;
  onChange: (status: LeadStatus) => void;
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        className="kaki-btn kaki-btn--secondary lead-status-menu"
        disabled={busy}
        aria-busy={busy || undefined}
      >
        {busy ? 'Saving…' : `Status: ${LEAD_STATUS[status].label}`}
        <Glyph name="chevron-down" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
          <DropdownMenu.RadioGroup
            value={status}
            onValueChange={(v) => {
              if (v !== status) onChange(LeadStatus.parse(v));
            }}
          >
            {LeadStatus.options.map((s) => (
              <DropdownMenu.RadioItem key={s} value={s} className="menu__item lead-status-item">
                <span className="lead-status-item__check" aria-hidden="true">
                  {s === status ? '✓' : ''}
                </span>
                {LEAD_STATUS[s].label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** SCR-APP-032 (FEAT-051): a row whose contact withdrew consent; it stays in its status tab. */
export function WithdrawnChip() {
  return (
    <span className="chip chip--neutral consent-withdrawn" data-testid="withdrawn-chip">
      <Glyph name="alert" size={12} />
      Consent withdrawn
    </span>
  );
}

export function MarketingFlag({ marketing }: { marketing: LeadMarketing }) {
  return <span className="lead-marketing">{marketingText(marketing)}</span>;
}

/** Saves the CSV under its name through a temporary object URL. */
export function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  // Attached for Firefox, which ignores clicks on a detached link.
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Export CSV (design.md §4.10 sensitive action): confirm, then re-auth when the server asks
 * (FEAT-006 guard), then the browser downloads the file. Focus goes back to Export CSV.
 */
export function ExportDialog({
  open,
  onOpenChange,
  title,
  filter,
  returnTo,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  filter: LeadsFilter;
  returnTo: RefObject<HTMLButtonElement | null>;
  onToast: (message: string) => void;
}) {
  const { guard } = useReauthGuard();
  const [tooMany, setTooMany] = useState(false);
  const run = useMutation({
    mutationFn: () =>
      guard(() =>
        api.exportLeads({
          status: filter.status,
          ...(filter.score ? { score: filter.score } : {}),
        }),
      ),
    onMutate: () => setTooMany(false),
    onSuccess: (res) => {
      save(res.blob, res.name ?? exportFileName(new Date()));
      const n = csvLeadCount(res.text);
      onOpenChange(false);
      onToast(
        `Exported ${n} ${n === 1 ? 'lead' : 'leads'}. This export is recorded in the audit log.`,
      );
    },
    onError: (err) => {
      if (err instanceof ReauthCancelled) return onOpenChange(false);
      if (err instanceof ApiError && err.status === 413) return setTooMany(true);
      onOpenChange(false);
      onToast("Couldn't export. Try again.");
    },
  });
  const note = filterNote(filter);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTooMany(false);
        onOpenChange(next);
      }}
      title={title}
      confirmLabel="Export"
      busy={run.isPending}
      busyLabel="Exporting…"
      onConfirm={() => run.mutate()}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        returnTo.current?.focus();
      }}
      alert={
        tooMany ? (
          <div className="alert alert--danger" role="alert">
            <p>That's more than 10,000 leads. Pick a status or score to export fewer.</p>
          </div>
        ) : undefined
      }
    >
      {note && <p className="lead-export__filters">{note}</p>}
      <p>
        The file includes names, phone numbers and emails. Keep it safe and delete it when you're
        done.
      </p>
      <p className="lead-export__filters">Leads whose consent was withdrawn are left out.</p>
      <div className="alert alert--info">
        <p>
          The Do Not Call Registry applies before you call or text anyone for marketing. Check the
          Offers column.
        </p>
      </div>
    </ConfirmDialog>
  );
}

/**
 * Record a withdrawal the person asked for directly (SCR-APP-033; FEAT-051 ui-design, LED-07,
 * UC-28 1a). "Only stop offers" shows only when the latest marketing answer is agreed. On
 * success the page takes the response and focus returns to the Consent heading.
 */
export function RecordWithdrawalDialog({
  open,
  onOpenChange,
  lead,
  returnTo,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadDetail;
  returnTo: RefObject<HTMLElement | null>;
  onToast: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const offers = offersWithdrawable(lead);
  const [scope, setScope] = useState<WithdrawScope>('all');
  const [failed, setFailed] = useState(false);
  const run = useMutation({
    mutationFn: () => api.withdrawLead(lead.id, { scope: offers ? scope : 'all' }),
    onMutate: () => setFailed(false),
    onSuccess: (detail) => {
      queryClient.setQueryData<LeadDetail>(leadKey(lead.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      onOpenChange(false);
      onToast('Withdrawal recorded');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 403) {
        onOpenChange(false);
        return onToast("You can't change leads.");
      }
      setFailed(true);
    },
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFailed(false);
          setScope('all');
        }
        onOpenChange(next);
      }}
      title="Record a consent withdrawal"
      confirmLabel="Record withdrawal"
      confirmVariant="danger"
      busy={run.isPending}
      busyLabel="Recording…"
      onConfirm={() => run.mutate()}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        returnTo.current?.focus();
      }}
      alert={
        failed ? (
          <div className="alert alert--danger" role="alert">
            <p>Couldn't record it. Try again.</p>
          </div>
        ) : undefined
      }
    >
      <p>
        Use this when {lead.name || 'this person'} asked you directly to stop using their details.
        Only they can give consent again, in a later chat.
      </p>
      {offers && (
        <fieldset className="radio-group" data-testid="withdraw-scope">
          <legend className="field__label">What did they ask?</legend>
          {(
            [
              ['all', 'Stop all use of their details'],
              ['marketing', 'Only stop offers'],
            ] as const
          ).map(([value, label]) => (
            <label className="radio" key={value}>
              <input
                type="radio"
                name="withdraw-scope"
                checked={scope === value}
                onChange={() => setScope(value)}
                disabled={run.isPending}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
    </ConfirmDialog>
  );
}

const CONSENT_TEXT = {
  enquiry: {
    agreed: 'Agreed to be contacted',
    declined: 'Chose not to share details',
    withdrawn: 'Withdrew consent',
  },
  marketing: {
    agreed: 'Agreed to offers',
    declined: 'Declined offers',
    withdrawn: 'Stopped offers',
  },
} as const;

/** One consent record (SCR-APP-033, reused by SCR-APP-016 Contact, FEAT-039). */
export function ConsentEntry({ c }: { c: LeadConsentRecord }) {
  const where = consentWhere(c);
  return (
    <li className="lead-consent" data-testid="lead-consent" data-decision={c.decision}>
      <p className="lead-consent__what">{CONSENT_TEXT[c.purpose][c.decision]}</p>
      <p className="lead-fields__caption">
        {dateTime(c.at)} · {where.text}
        {where.conversationId && (
          <>
            {' · '}
            <Link to={`/inbox/${where.conversationId}`}>See conversation</Link>
          </>
        )}
      </p>
      {c.wording && (
        <details className="lead-consent__wording">
          <summary>Wording shown (version {c.wording.version})</summary>
          <p>{c.wording.text}</p>
        </details>
      )}
    </li>
  );
}
