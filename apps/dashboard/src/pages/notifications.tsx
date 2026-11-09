import type { AlertEvent, NotificationChannel, NotificationPrefs } from '@kaki/contracts';
import { Button, ErrorState } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy, useToast } from '../lib/form.ts';
import {
  EVENT_TEXT,
  quietError,
  quietHelp,
  quietServerError,
  testErrorText,
  useNotificationPrefs,
  useSaveNotificationPrefs,
  useSendTestAlert,
  type PrefsChange,
  type QuietError,
} from '../lib/notifications.ts';

/** SCR-APP-056 My notifications (FEAT-052 ui-design). */

type OnToast = (t: string) => void;

const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  email: 'Email',
  telegram: 'Telegram',
};

export function NotificationsPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const prefs = useNotificationPrefs();
  const [toast, setToast] = useToast();
  const business = me.data?.tenant?.name ?? 'this business';

  return (
    <div className="notif-page">
      <Link className="back-link kaki-btn kaki-btn--ghost" to="/account">
        ← My account
      </Link>
      <h1 className="page-title">Notifications</h1>
      <p className="page-lede">
        Choose what we alert you about at {business}, and when to hold alerts.
      </p>
      {prefs.isError ? (
        <ErrorState
          title="We couldn't load your notification settings."
          action={
            <Button variant="secondary" onClick={() => void prefs.refetch()}>
              Try again
            </Button>
          }
        />
      ) : prefs.data ? (
        <>
          <AlertsCard prefs={prefs.data} business={business} onToast={setToast} />
          <QuietHoursCard prefs={prefs.data} onToast={setToast} />
          <TestCard onToast={setToast} />
        </>
      ) : (
        [0, 1, 2].map((k) => (
          <section
            key={k}
            className="card account-card"
            aria-busy="true"
            aria-label="Loading notification settings"
          >
            <div className="skeleton-line notif-skeleton__title" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </section>
        ))
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

/** A `toggle` that saves on change; while saving it is busy and ignores presses. */
function SaveSwitch({
  checked,
  change,
  onSaved,
  onFailed,
  ...aria
}: {
  checked: boolean;
  change: PrefsChange;
  onSaved: () => void;
  onFailed: () => void;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const save = useSaveNotificationPrefs();
  return (
    <button
      type="button"
      role="switch"
      className="toggle toggle--touch"
      aria-checked={checked}
      aria-busy={save.isPending || undefined}
      {...aria}
      onClick={() => {
        if (save.isPending) return;
        save.mutate(change, { onSuccess: onSaved, onError: onFailed });
      }}
    >
      <span className="toggle__thumb" aria-hidden="true" />
    </button>
  );
}

function AlertsCard({
  prefs,
  business,
  onToast,
}: {
  prefs: NotificationPrefs;
  business: string;
  onToast: OnToast;
}) {
  const [failed, setFailed] = useState(false);
  const allOff = prefs.events.every((e) => prefs.channels.every((c) => !e[c]));
  const saved = () => {
    setFailed(false);
    onToast('Saved.');
  };
  return (
    <section className="card account-card" aria-labelledby="notif-alerts-title">
      <h2 className="section-title" id="notif-alerts-title">
        What to alert me about
      </h2>
      {failed && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn&apos;t save that. Try again.</p>
        </div>
      )}
      <p className="notif-sendto">
        Alerts go to <span className="account-card__address">{prefs.sendTo.email}</span>.{' '}
        <Link className="kaki-btn kaki-btn--ghost" to="/account">
          Change email
        </Link>
      </p>
      <div className="notif-list">
        <div className="notif-list__head" aria-hidden="true">
          {prefs.channels.map((c) => (
            <span key={c} className="notif-list__channel">
              {CHANNEL_LABEL[c]}
            </span>
          ))}
        </div>
        <ul className="notif-list__rows">
          {prefs.events.map((e) => (
            <EventRow
              key={e.event}
              event={e.event}
              channels={prefs.channels}
              value={e}
              onSaved={saved}
              onFailed={() => setFailed(true)}
            />
          ))}
        </ul>
      </div>
      {allOff && (
        <div className="alert alert--info">
          <p>
            You won&apos;t get any email alerts at {business}. You&apos;ll still see everything in
            the inbox.
          </p>
        </div>
      )}
    </section>
  );
}

function EventRow({
  event,
  channels,
  value,
  onSaved,
  onFailed,
}: {
  event: AlertEvent;
  channels: NotificationChannel[];
  value: NotificationPrefs['events'][number];
  onSaved: () => void;
  onFailed: () => void;
}) {
  const text = EVENT_TEXT[event];
  return (
    <li className="notif-row">
      <span className="notif-row__text">
        <span className="notif-row__label">{text.label}</span>
        <span className="notif-row__help">{text.help}</span>
      </span>
      <span className="notif-row__switches">
        {channels.map((c) => (
          <span key={c} className="notif-row__switch">
            <span className="notif-row__channel" aria-hidden="true">
              {CHANNEL_LABEL[c]}
            </span>
            <SaveSwitch
              checked={value[c] ?? true}
              change={
                c === 'email'
                  ? { event, email: !value.email }
                  : { event, email: value.email, telegram: !(value.telegram ?? true) }
              }
              aria-label={`${CHANNEL_LABEL[c]} alerts: ${text.label}`}
              onSaved={onSaved}
              onFailed={onFailed}
            />
          </span>
        ))}
      </span>
    </li>
  );
}

function QuietHoursCard({ prefs, onToast }: { prefs: NotificationPrefs; onToast: OnToast }) {
  const q = prefs.quietHours;
  const save = useSaveNotificationPrefs();
  const [draft, setDraft] = useState({ start: q.start, end: q.end });
  const [error, setError] = useState<QuietError | null>(null);
  const [failed, setFailed] = useState(false);
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);

  // A save elsewhere (another tab, a refetch) moves the saved times: follow them when untouched.
  const [seen, setSeen] = useState({ start: q.start, end: q.end });
  if (seen.start !== q.start || seen.end !== q.end) {
    setSeen({ start: q.start, end: q.end });
    setDraft({ start: q.start, end: q.end });
  }

  const dirty = draft.start !== q.start || draft.end !== q.end;
  const showError = (e: QuietError) => {
    setError(e);
    (e.field === 'start' ? startRef : endRef).current?.focus();
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (save.isPending) return;
    const invalid = quietError(draft);
    if (invalid) return showError(invalid);
    setError(null);
    setFailed(false);
    save.mutate(
      { quietHours: { enabled: q.enabled, ...draft } },
      {
        onSuccess: () => onToast('Quiet hours saved.'),
        onError: (err) => {
          const fieldError = quietServerError(err);
          if (fieldError) showError(fieldError);
          else setFailed(true);
        },
      },
    );
  };

  const fieldProps = (field: 'start' | 'end') => {
    const id = `notif-quiet-${field}`;
    const err = error?.field === field ? error.text : undefined;
    return {
      id,
      error: err,
      input: {
        id,
        className: 'input',
        type: 'time',
        step: 60,
        value: draft[field],
        'aria-invalid': err ? true : undefined,
        'aria-describedby': describedBy(id, err),
        onChange: (e: { target: { value: string } }) => {
          setDraft((d) => ({ ...d, [field]: e.target.value }));
          if (error?.field === field) setError(null);
        },
      },
    };
  };
  const from = fieldProps('start');
  const to = fieldProps('end');

  return (
    <section className="card account-card" aria-labelledby="notif-quiet-title">
      <h2 className="section-title" id="notif-quiet-title">
        Quiet hours
      </h2>
      {failed && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn&apos;t save your quiet hours. Try again.</p>
        </div>
      )}
      <div className="notif-row notif-row--plain">
        <span className="notif-row__label" id="notif-quiet-label">
          Hold alerts during quiet hours
        </span>
        <SaveSwitch
          checked={q.enabled}
          change={{ quietHours: { ...q, enabled: !q.enabled } }}
          aria-labelledby="notif-quiet-label"
          onSaved={() => {
            setFailed(false);
            onToast('Saved.');
          }}
          onFailed={() => setFailed(true)}
        />
      </div>
      {q.enabled ? (
        <form className="account-form" noValidate onSubmit={submit}>
          <div className="notif-quiet__times">
            <Field id={from.id} label="From" error={from.error}>
              <input ref={startRef} {...from.input} />
            </Field>
            <Field id={to.id} label="To" error={to.error}>
              <input ref={endRef} {...to.input} />
            </Field>
          </div>
          <p className="field__help">{quietHelp({ ...q, ...draft })}</p>
          <div className="account-card__actions">
            <Button type="submit" disabled={!dirty} aria-disabled={save.isPending || undefined}>
              {save.isPending ? 'Saving…' : 'Save quiet hours'}
            </Button>
          </div>
        </form>
      ) : (
        <p className="field__help">{quietHelp(q)}</p>
      )}
    </section>
  );
}

function TestCard({ onToast }: { onToast: OnToast }) {
  const send = useSendTestAlert();
  const failure = send.isError ? testErrorText(send.error) : null;
  return (
    <section className="card account-card" aria-labelledby="notif-test-title">
      <h2 className="section-title" id="notif-test-title">
        Test
      </h2>
      <p>Send yourself a test alert to check it reaches your inbox. It ignores quiet hours.</p>
      <div className="account-card__actions">
        <Button
          variant="secondary"
          aria-disabled={send.isPending || undefined}
          onClick={() => {
            if (send.isPending) return;
            send.mutate(undefined, {
              onSuccess: (res) =>
                onToast(`Test alert sent to ${res.sentTo}. It should arrive within a minute.`),
            });
          }}
        >
          {send.isPending ? 'Sending…' : 'Send me a test alert'}
        </Button>
      </div>
      {failure && (
        // The 429 warning is static text that replaces itself (ui-design), so no live role.
        <div
          className={`alert alert--${failure.tone}`}
          role={failure.tone === 'danger' ? 'alert' : undefined}
        >
          <p>{failure.text}</p>
        </div>
      )}
    </section>
  );
}
