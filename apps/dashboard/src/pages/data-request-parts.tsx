import {
  DSR_TYPES,
  sgToday,
  type DsrDetail,
  type DsrStatus,
  type DsrSummary,
} from '@kaki/contracts';
import { Button, FormDialog } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import {
  countsText,
  draftOf,
  draftRequester,
  dsrErrorText,
  dsrKey,
  dueText,
  emptyDraft,
  STATUS_CHIP,
  TYPE_HINT,
  TYPE_LABEL,
  useDataRequests,
  validateDraft,
  type DraftErrors,
  type RequestDraft,
} from '../lib/data-requests.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { ErrorSummary } from './privacy-parts.tsx';

/** The parts SCR-APP-048 Data requests and SCR-APP-049 Data request share (FEAT-061). */

export function StatusChip({ status }: { status: DsrStatus }) {
  const s = STATUS_CHIP[status];
  return (
    <span className={`chip chip--${s.tone}`} data-testid="dsr-status">
      {s.label}
    </span>
  );
}

export function DueChip({ r }: { r: Pick<DsrSummary, 'dueOn' | 'dueState'> }) {
  const due = dueText(r);
  if (!due) return null;
  if (due.tone === 'caption')
    return (
      <span className="dsr-due" data-testid="dsr-due">
        {due.text}
      </span>
    );
  return (
    <span className={`chip chip--${due.tone}`} data-testid="dsr-due">
      {due.text}
    </span>
  );
}

export function Breadcrumb({ current, request }: { current: string; request?: boolean }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="email-breadcrumb">
        <li>
          <Link to="/settings">Settings</Link>
        </li>
        <li>
          <Link to="/settings/privacy">Privacy and data</Link>
        </li>
        {request && (
          <li>
            <Link to="/settings/privacy/requests">Data requests</Link>
          </li>
        )}
        <li aria-current="page">{current}</li>
      </ol>
    </nav>
  );
}

const FIELD_ORDER = ['type', 'receivedOn', 'email', 'phone', 'telegramId'] as const;

/**
 * New / Edit request (`form-dialog`): errors show on submit or after leaving a field, with an
 * `ErrorSummary` at the top (guide `required-field-feedback`). New navigates to the request;
 * Edit (open requests only) saves on the request's `version`.
 */
export function RequestFormDialog({
  open,
  onOpenChange,
  detail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail?: DsrDetail;
  onSaved: (d: DsrDetail) => void;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={detail ? 'Edit request' : 'New data request'}
      className="dsr-form-dialog"
    >
      {open && (
        <RequestForm detail={detail} onCancel={() => onOpenChange(false)} onSaved={onSaved} />
      )}
    </FormDialog>
  );
}

function RequestForm({
  detail,
  onCancel,
  onSaved,
}: {
  detail: DsrDetail | undefined;
  onCancel: () => void;
  onSaved: (d: DsrDetail) => void;
}) {
  const queryClient = useQueryClient();
  const today = sgToday();
  const [draft, setDraft] = useState<RequestDraft>(() =>
    detail ? draftOf(detail) : emptyDraft(today),
  );
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(0);
  const errors = validateDraft(draft, today);
  const shown: DraftErrors = {};
  for (const k of FIELD_ORDER) if (submitted || touched.has(k)) shown[k] = errors[k];
  const leave = (k: string) => () => setTouched((t) => (t.has(k) ? t : new Set(t).add(k)));
  const set = (patch: Partial<RequestDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const type = draft.type || 'access';
      return detail
        ? api.updateDataRequest(detail.id, {
            version: detail.version,
            type,
            receivedOn: draft.receivedOn,
            requester: draftRequester(draft),
          })
        : api.createDataRequest({
            type,
            receivedOn: draft.receivedOn,
            requester: draftRequester(draft),
            note: draft.note,
          });
    },
    onSuccess: (d) => {
      queryClient.setQueryData(dsrKey(d.id), d);
      void queryClient.invalidateQueries({ queryKey: ['data-requests'] });
      void queryClient.invalidateQueries({ queryKey: [...dsrKey(d.id), 'find'] });
      onSaved(d);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted((n) => n + 1);
    if (Object.values(errors).some(Boolean)) return;
    save.mutate();
  };
  const busy = save.isPending;
  const summary: Record<string, string | undefined> = submitted
    ? Object.fromEntries(FIELD_ORDER.map((k) => [k, errors[k]]))
    : {};

  return (
    <form className="fact-form dsr-form" onSubmit={submit} noValidate>
      <ErrorSummary errors={summary} prefix="dsr" focusKey={submitted} />
      {save.isError && (
        <div className="alert alert--danger" role="alert">
          <p>{dsrErrorText(save.error)}</p>
        </div>
      )}
      <fieldset
        className="radio-group"
        aria-describedby={shown.type ? 'dsr-type-error' : undefined}
        aria-invalid={shown.type ? true : undefined}
      >
        <legend className="field__label">What are they asking for?</legend>
        {DSR_TYPES.map((t, i) => (
          <label className="radio" key={t}>
            <input
              type="radio"
              name="dsr-type"
              id={i === 0 ? 'dsr-type' : undefined}
              checked={draft.type === t}
              onChange={() => set({ type: t })}
              onBlur={leave('type')}
              disabled={busy}
            />
            <span>
              <strong>{TYPE_LABEL[t]}</strong>{' '}
              <span className="dsr-form__hint">{TYPE_HINT[t]}</span>
            </span>
          </label>
        ))}
        {shown.type && (
          <p className="field__error" id="dsr-type-error">
            <span aria-hidden="true">!</span> {shown.type}
          </p>
        )}
      </fieldset>
      <Field id="dsr-receivedOn" label="Received on" error={shown.receivedOn}>
        <input
          id="dsr-receivedOn"
          className="input"
          type="date"
          max={today}
          value={draft.receivedOn}
          onChange={(e) => set({ receivedOn: e.target.value })}
          onBlur={leave('receivedOn')}
          aria-invalid={shown.receivedOn ? true : undefined}
          aria-describedby={describedBy('dsr-receivedOn', shown.receivedOn)}
          readOnly={busy}
        />
      </Field>
      <fieldset className="dsr-form__requester" aria-describedby="dsr-requester-help">
        <legend className="subsection-title">Requester</legend>
        <p className="field__help" id="dsr-requester-help">
          At least one of email, phone or Telegram user ID, so we can search for their data.
        </p>
        <Field id="dsr-name" label="Name (optional)">
          <input
            id="dsr-name"
            className="input"
            autoComplete="off"
            maxLength={120}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            readOnly={busy}
          />
        </Field>
        <Field id="dsr-email" label="Email" error={shown.email}>
          <input
            id="dsr-email"
            className="input"
            type="email"
            autoComplete="off"
            value={draft.email}
            onChange={(e) => set({ email: e.target.value })}
            onBlur={leave('email')}
            aria-invalid={shown.email ? true : undefined}
            aria-describedby={describedBy('dsr-email', shown.email)}
            readOnly={busy}
          />
        </Field>
        <Field id="dsr-phone" label="Phone (+65)" error={shown.phone}>
          <input
            id="dsr-phone"
            className="input"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={draft.phone}
            onChange={(e) => set({ phone: e.target.value })}
            onBlur={leave('phone')}
            aria-invalid={shown.phone ? true : undefined}
            aria-describedby={describedBy('dsr-phone', shown.phone)}
            readOnly={busy}
          />
        </Field>
        <Field
          id="dsr-telegramId"
          label="Telegram user ID"
          error={shown.telegramId}
          help="Numbers only. Ask them to send /start to your bot, or find it in the chat."
        >
          <input
            id="dsr-telegramId"
            className="input"
            inputMode="numeric"
            autoComplete="off"
            value={draft.telegramId}
            onChange={(e) => set({ telegramId: e.target.value })}
            onBlur={leave('telegramId')}
            aria-invalid={shown.telegramId ? true : undefined}
            aria-describedby={describedBy('dsr-telegramId', shown.telegramId, true)}
            readOnly={busy}
          />
        </Field>
      </fieldset>
      {!detail && (
        <Field id="dsr-note" label="Note (optional)" help="Anything else they asked for">
          <textarea
            id="dsr-note"
            className="input input--area"
            rows={3}
            maxLength={500}
            value={draft.note}
            onChange={(e) => set({ note: e.target.value })}
            aria-describedby="dsr-note-help"
            readOnly={busy}
          />
        </Field>
      )}
      <div className="kaki-dialog__actions">
        <Button variant="secondary" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
          {detail ? (busy ? 'Saving…' : 'Save changes') : busy ? 'Logging…' : 'Log request'}
        </Button>
      </div>
    </form>
  );
}

/** SCR-APP-047's "Data requests" row: the open and due-soon counts and the way in. */
export function DataRequestsCard() {
  const list = useDataRequests('open');
  const counts = list.data?.pages[0]?.counts;
  return (
    <section className="card stack" aria-labelledby="privacy-dsr-title" data-testid="privacy-dsr">
      <h2 className="section-title" id="privacy-dsr-title">
        Data requests
      </h2>
      <p className="privacy-lede">
        Requests from customers to see, correct or delete their personal data.
      </p>
      {counts && (
        <p className="dsr-counts">
          {countsText(counts)}
          {counts.dueSoon + counts.overdue > 0 && (
            <span className="count-pill count-pill--warning">
              {counts.dueSoon + counts.overdue}
              <span className="sr-only"> need action soon</span>
            </span>
          )}
        </p>
      )}
      <p>
        <Link to="/settings/privacy/requests">Manage requests</Link>
      </p>
    </section>
  );
}
