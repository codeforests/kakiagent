import type { AuditRow, AuditVerifyResult } from '@kaki/contracts';
import { AUDIT_GROUP_KEYS } from '@kaki/contracts';
import { Button, ConfirmDialog, SlideOver } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type RefObject } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import {
  actorText,
  AUDIT_KEY,
  auditExportErrorText,
  auditFileName,
  cooldownText,
  dateRangeError,
  eventText,
  exportBodyOf,
  filterSummary,
  fullTime,
  GROUP_LABEL,
  keyText,
  lastVerifiedText,
  listTime,
  PII_TEXT,
  QUICK_RANGES,
  quickRangeOf,
  RUNNING_TEXT,
  seqText,
  sgDate,
  shortId,
  showSeqOf,
  subjectLabel,
  subjectLink,
  useLastVerification,
  useVerify,
  valueText,
  verifyBusy,
  verifyText,
  without,
  type AuditFilter,
} from '../lib/audit.ts';
import { save } from '../lib/download.ts';
import { ReauthCancelled, useReauthGuard } from '../lib/reauth.ts';
import { Glyph } from './conversation-parts.tsx';

/** The parts of SCR-APP-050 Audit log (FEAT-060 ui-design). */

type Member = { id: string; name: string };

// ---- Chain verification --------------------------------------------------------------------

/**
 * "Chain verification": the last result, a run (verifying → intact / problem found), and the
 * cooldown (429) and running-elsewhere (409) states, which aren't errors (AC-7).
 */
export function VerifyCard({ onShowEntry }: { onShowEntry: (seq: number) => void }) {
  const last = useLastVerification();
  const run = useVerify();
  const [wait, setWait] = useState(0);
  // The last run's result stays shown through a later cooldown or running answer.
  const [result, setResult] = useState<AuditVerifyResult | null>(null);
  const busy = verifyBusy(run.error);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const lastOk = last.data?.last;
  const broken = result ? !result.ok : lastOk ? !lastOk.ok : false;
  const chip = result || lastOk ? (broken ? 'danger' : 'success') : null;
  const message = result ? verifyText(result) : null;
  const show = result ? showSeqOf(result) : null;

  if (last.isPending)
    return (
      <section className="card audit-verify" aria-busy="true" aria-label="Chain verification">
        <div className="skeleton-field" />
      </section>
    );

  return (
    <section className="card audit-verify" aria-labelledby="audit-verify-title">
      <div className="audit-verify__head">
        <h2 className="audit-verify__title" id="audit-verify-title">
          Chain verification
        </h2>
        {chip && (
          <span className={`chip chip--${chip}`} data-testid="audit-verify-chip">
            {broken ? 'Problem found' : 'Intact'}
          </span>
        )}
      </div>
      {!lastOk && !result && <p>Check that no entry has been changed or removed.</p>}
      {lastOk && <p className="audit-verify__last">{lastVerifiedText(lastOk)}</p>}
      <p className="sr-only" aria-live="polite">
        {run.isPending ? 'Checking every entry. This can take up to a minute.' : ''}
      </p>
      {run.isPending && (
        <p className="audit-verify__note" aria-hidden="true">
          Checking every entry. This can take up to a minute.
        </p>
      )}
      {message && (
        <div
          className={`alert alert--${message.tone}`}
          role={message.tone === 'danger' ? 'alert' : undefined}
          data-testid="audit-verify-result"
        >
          <p>{message.text}</p>
          {show !== null && (
            <p>
              <Button variant="ghost" onClick={() => onShowEntry(show)}>
                Show entry
              </Button>
            </p>
          )}
          {message.tone === 'danger' && (
            <p className="audit-verify__note">
              Contact support. Entries after this point can't be trusted until it's explained.
            </p>
          )}
        </div>
      )}
      {busy?.kind === 'cooldown' && wait > 0 && (
        <p className="audit-verify__note">{cooldownText(wait)}</p>
      )}
      {busy?.kind === 'running' && <p className="audit-verify__note">{RUNNING_TEXT}</p>}
      {run.isError && !busy && (
        <div className="alert alert--danger" role="alert">
          <p>Couldn't verify the chain. Try again.</p>
        </div>
      )}
      <div className="audit-verify__actions">
        <Button
          variant="secondary"
          onClick={() =>
            run.mutate(undefined, {
              onSuccess: setResult,
              onError: (err) => {
                const b = verifyBusy(err);
                if (b?.kind === 'cooldown') setWait(b.seconds);
              },
            })
          }
          disabled={run.isPending || wait > 0}
          aria-busy={run.isPending || undefined}
        >
          {run.isPending ? 'Verifying…' : lastOk || result ? 'Verify again' : 'Verify audit chain'}
        </Button>
      </div>
    </section>
  );
}

// ---- Filters -------------------------------------------------------------------------------

/** The "Who" select's value for a filter, and back. */
const whoOf = (f: AuditFilter) => (f.actor ? `m:${f.actor}` : (f.actorType ?? ''));
function withWho(f: AuditFilter, v: string): AuditFilter {
  const rest = without(f, 'actor', 'actorType');
  if (v.startsWith('m:')) return { ...rest, actorType: 'user', actor: v.slice(2) };
  return v ? { ...rest, actorType: v as AuditFilter['actorType'] } : rest;
}

/**
 * The filters (date range with quick chips, Type, Who, the conversation chip). Changes go to
 * the URL at once; an end date before the start date stays in the field with its error.
 */
export function AuditFiltersBar({
  filter,
  members,
  onChange,
  idPrefix,
  now,
}: {
  filter: AuditFilter;
  members: Member[];
  onChange: (f: AuditFilter) => void;
  idPrefix: string;
  now: Date;
}) {
  // An invalid range stays here with its error; a valid one goes to the URL.
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);
  const from = draft?.from ?? filter.from ?? '';
  const to = draft?.to ?? filter.to ?? '';
  const error = dateRangeError(from || undefined, to || undefined);
  const setDates = (f: string, t: string) => {
    if (dateRangeError(f || undefined, t || undefined)) return setDraft({ from: f, to: t });
    setDraft(null);
    onChange({
      ...without(filter, 'from', 'to'),
      ...(f ? { from: f } : {}),
      ...(t ? { to: t } : {}),
    });
  };
  const quick = quickRangeOf(filter, now);
  const errId = `${idPrefix}-to-error`;

  return (
    <div className="audit-filters">
      <div className="audit-filters__dates">
        <label className="field">
          <span className="field__label">From</span>
          <input
            className="input"
            type="date"
            value={from}
            max={sgDate(now)}
            onChange={(e) => setDates(e.target.value, to)}
          />
        </label>
        <label className="field">
          <span className="field__label">To</span>
          <input
            className="input"
            type="date"
            value={to}
            max={sgDate(now)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => setDates(from, e.target.value)}
          />
          {error && (
            <span className="field__error" id={errId}>
              {error}
            </span>
          )}
        </label>
      </div>
      <div className="audit-filters__quick" role="group" aria-label="Quick date ranges">
        {QUICK_RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            className="audit-chip"
            aria-pressed={quick?.key === r.key}
            onClick={() => setDates(sgDate(now, r.days), sgDate(now))}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="field audit-filters__select">
        <label className="field__label" htmlFor={`${idPrefix}-type`}>
          Type
        </label>
        <select
          id={`${idPrefix}-type`}
          className="input"
          value={filter.group ?? ''}
          onChange={(e) => {
            const rest = without(filter, 'group');
            const v = e.target.value as AuditFilter['group'];
            onChange(v ? { ...rest, group: v } : rest);
          }}
        >
          <option value="">All types</option>
          {AUDIT_GROUP_KEYS.map((g) => (
            <option key={g} value={g}>
              {GROUP_LABEL[g]}
            </option>
          ))}
        </select>
      </div>
      <div className="field audit-filters__select">
        <label className="field__label" htmlFor={`${idPrefix}-who`}>
          Who
        </label>
        <select
          id={`${idPrefix}-who`}
          className="input"
          value={whoOf(filter)}
          onChange={(e) => onChange(withWho(filter, e.target.value))}
        >
          <option value="">Anyone</option>
          <option value="agent">Assistant</option>
          <option value="user">Team (any member)</option>
          {members.map((m) => (
            <option key={m.id} value={`m:${m.id}`}>
              {m.name}
            </option>
          ))}
          <option value="system">System</option>
          <option value="visitor">Visitor</option>
          <option value="operator">KakiAgent support</option>
        </select>
      </div>
    </div>
  );
}

/** The removable conversation chip, shown when `?conversation=` is set. */
export function ConversationChip({ id, onClear }: { id: string; onClear: () => void }) {
  return (
    <span className="chip chip--neutral audit-conversation" data-testid="audit-conversation-chip">
      Conversation <span className="audit-mono">{shortId(id)}</span>
      <button
        type="button"
        className="audit-conversation__clear"
        aria-label="Clear conversation filter"
        onClick={onClear}
      >
        ×
      </button>
    </span>
  );
}

/** Phones: the same filters in a bottom sheet behind "Filters (n)". */
export function FiltersSheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <SlideOver
      open={open}
      onOpenChange={onOpenChange}
      title="Filters"
      className="details-drawer audit-sheet"
    >
      {children}
      <div className="audit-sheet__actions">
        <Button onClick={() => onOpenChange(false)}>Show results</Button>
      </div>
    </SlideOver>
  );
}

// ---- List ----------------------------------------------------------------------------------

function about(row: AuditRow) {
  const s = row.subjects[0];
  if (!s) return null;
  return (
    <>
      {subjectLabel(s.type)} <span className="audit-mono">{shortId(s.id)}</span>
    </>
  );
}

/** The entries: a table at ≥ 768 px, stacked rows below; each row is one button. */
export function AuditTable({
  rows,
  now,
  onOpen,
}: {
  rows: AuditRow[];
  now: Date;
  onOpen: (seq: number) => void;
}) {
  return (
    <table className="fact-table audit-table" data-testid="audit-table">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Who</th>
          <th scope="col">What</th>
          <th scope="col">About</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const when = listTime(r.ts, now);
          const what = eventText(r.eventType);
          const who = actorText(r);
          return (
            <tr
              key={r.seq}
              className="fact-row audit-row"
              data-testid="audit-row"
              data-seq={r.seq}
              data-event={r.eventType}
            >
              <td className="audit-row__when">
                <button
                  type="button"
                  className="audit-row__open"
                  aria-label={`${what}, ${who}, ${when}`}
                  onClick={() => onOpen(r.seq)}
                />
                {when}
              </td>
              <td className="audit-row__who">{who}</td>
              <td className="audit-row__what">
                <span className="audit-row__event">{what}</span>
                <span className="audit-row__code audit-mono">{r.eventType}</span>
              </td>
              <td className="audit-row__about">{about(r)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---- Entry detail --------------------------------------------------------------------------

function CopyHash({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="audit-hash">
      <dt>{label}</dt>
      <dd>
        <span className="audit-mono audit-hash__value">{value}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
          onBlur={() => setCopied(false)}
        >
          <Glyph name="copy" />
        </button>
        <span className="sr-only" role="status">
          {copied ? 'Copied' : ''}
        </span>
      </dd>
    </div>
  );
}

/** One entry in a slide-over (a full-height sheet on phones); never any personal data (D5). */
export function EntryDetail({
  seq,
  row,
  state,
  onClose,
  returnTo,
}: {
  seq: number | null;
  row: AuditRow | undefined;
  state: 'loading' | 'not_found' | 'error' | 'ready';
  onClose: () => void;
  /** The row or "Show entry" button that opened it; focus goes back there on close. */
  returnTo: RefObject<HTMLElement | null>;
}) {
  const payload = row ? Object.entries(row.payload) : [];
  return (
    <SlideOver
      open={seq !== null}
      onOpenChange={(o) => !o && onClose()}
      title={seq === null ? 'Entry' : `Entry ${seqText(seq)}`}
      className="audit-detail"
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        returnTo.current?.focus();
      }}
    >
      {state === 'loading' && <div className="skeleton-field" aria-busy="true" />}
      {state === 'not_found' && <p>This entry doesn't exist.</p>}
      {state === 'error' && <p>Couldn't load this entry. Try again.</p>}
      {state === 'ready' && row && (
        <dl className="audit-dl" data-testid="audit-detail">
          <div>
            <dt>When</dt>
            <dd>{fullTime(row.ts)}</dd>
          </div>
          <div>
            <dt>Who</dt>
            <dd>{actorText(row)}</dd>
          </div>
          <div>
            <dt>What</dt>
            <dd>
              {eventText(row.eventType)}{' '}
              <span className="audit-mono audit-row__code">{row.eventType}</span>
            </dd>
          </div>
          <div>
            <dt>About</dt>
            <dd>
              {row.subjects.length === 0 ? (
                '—'
              ) : (
                <ul className="audit-subjects">
                  {row.subjects.map((s) => {
                    const to = subjectLink(s);
                    const text = (
                      <>
                        {subjectLabel(s.type)} <span className="audit-mono">{s.id}</span>
                      </>
                    );
                    return (
                      <li key={`${s.type}:${s.id}`}>{to ? <Link to={to}>{text}</Link> : text}</li>
                    );
                  })}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt>Details</dt>
            <dd>
              {payload.length === 0 ? (
                'No details'
              ) : (
                <dl className="audit-payload">
                  {payload.map(([k, v]) => {
                    const t = valueText(v);
                    return (
                      <div key={k}>
                        <dt>{keyText(k)}</dt>
                        <dd>{t.mono ? <pre className="audit-mono">{t.text}</pre> : t.text}</dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </dd>
          </div>
          <div>
            <dt>Personal data</dt>
            <dd>{PII_TEXT[row.pii] ?? 'None'}</dd>
          </div>
          <CopyHash label="Hash" value={row.hash} />
          <CopyHash label="Previous hash" value={row.prevHash} />
        </dl>
      )}
      <div className="audit-sheet__actions">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </SlideOver>
  );
}

// ---- Export --------------------------------------------------------------------------------

/**
 * Export (design.md §4.10 sensitive action): format, the filters it covers, then re-auth when
 * the server asks, then the download; the list refetches to show the `audit.exported` entry.
 */
export function AuditExportDialog({
  open,
  onOpenChange,
  filter,
  members,
  returnTo,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter: AuditFilter;
  members: Member[];
  returnTo: RefObject<HTMLButtonElement | null>;
  onToast: (message: string) => void;
}) {
  const { guard } = useReauthGuard();
  const qc = useQueryClient();
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => guard(() => api.exportAudit(exportBodyOf(filter, format))),
    onMutate: () => setError(null),
    onSuccess: (res) => {
      save(res.blob, res.name ?? auditFileName(new Date(), format));
      onOpenChange(false);
      onToast('Audit log exported. This export is recorded in the log.');
      void qc.invalidateQueries({ queryKey: AUDIT_KEY });
    },
    onError: (err) => {
      if (err instanceof ReauthCancelled) return onOpenChange(false);
      setError(auditExportErrorText(err));
    },
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      title="Export audit log"
      confirmLabel="Export"
      busy={run.isPending}
      busyLabel="Exporting…"
      onConfirm={() => run.mutate()}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        returnTo.current?.focus();
      }}
      alert={
        error ? (
          <div className="alert alert--danger" role="alert">
            <p>{error}</p>
          </div>
        ) : undefined
      }
    >
      <fieldset className="radio-group">
        <legend className="field__label">Format</legend>
        <label className="radio">
          <input
            type="radio"
            name="audit-format"
            checked={format === 'csv'}
            onChange={() => setFormat('csv')}
          />
          <span>CSV (spreadsheets)</span>
        </label>
        <label className="radio">
          <input
            type="radio"
            name="audit-format"
            checked={format === 'json'}
            onChange={() => setFormat('json')}
          />
          <span>JSON (for auditors; includes every chain field)</span>
        </label>
      </fieldset>
      <p className="lead-export__filters">{filterSummary(filter, members)}</p>
      <p>The file has IDs and codes, not customers' personal data.</p>
    </ConfirmDialog>
  );
}
