import type { EmailChannelResponse, EmailDomainRecord } from '@kaki/contracts';
import { Button, ConfirmDialog } from '@kaki/ui';
import * as Tabs from '@radix-ui/react-tabs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { relativeTime } from '../lib/coach.ts';
import {
  addressError,
  domainErrorText,
  domainMeta,
  domainStateChip,
  EMAIL_CHANNEL_KEY,
  ignoredLines,
  isStale,
  RECORD_PURPOSE,
  recordStatusText,
  REPLY_CAP_MAX,
  REPLY_CAP_MIN,
  replyCapError,
  shownRecords,
  useEmailUpdate,
  type Chip,
} from '../lib/email-channel.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { Glyph } from './conversation-parts.tsx';

/** The parts of SCR-APP-038 Email channel (FEAT-036 ui-design). */

type Toast = (message: string) => void;

const CHIP_GLYPH = { check: 'check', clock: 'clock', x: 'x-circle', alert: 'alert' } as const;

export function StatusChip({ chip }: { chip: Chip }) {
  return (
    <span className={`chip chip--${chip.tone} email-chip`}>
      <Glyph name={CHIP_GLYPH[chip.icon]} size={14} />
      {chip.text}
    </span>
  );
}

/** The settings version at save time: another card's save bumps it too. */
function useVersion(data: EmailChannelResponse) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.getQueryData<EmailChannelResponse>(EMAIL_CHANNEL_KEY)?.settingsVersion ??
    data.settingsVersion;
}

/** The 409 `stale` alert: reload to see the latest. */
function StaleAlert({ onReload }: { onReload: () => void }) {
  return (
    <div className="alert alert--danger" role="alert">
      <p>Someone else changed this. Reload to see the latest.</p>
      <Button variant="secondary" onClick={onReload}>
        Reload
      </Button>
    </div>
  );
}

/** A value with its own Copy button, announcing "Copied". */
export function CopyValue({
  value,
  label,
  className = '',
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className={`copy-value ${className}`}>
      <code className="copy-value__text">{value}</code>
      <Button
        variant="secondary"
        className="kaki-btn--sm"
        aria-label={label}
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <span className="sr-only" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </div>
  );
}

/** Not set up: one button creates the forwarding address. */
export function SetUpEmail({ onDone }: { onDone: (res: EmailChannelResponse) => void }) {
  const update = useEmailUpdate();
  const setup = useMutation({
    mutationFn: () => api.setupEmail(),
    onSuccess: (res) => {
      update(res);
      onDone(res);
    },
  });
  return (
    <section className="card email-setup" aria-labelledby="email-setup-title">
      <span className="email-setup__icon">
        <Glyph name="mail" size={24} />
      </span>
      <h2 className="section-title" id="email-setup-title">
        Answer customer emails
      </h2>
      <p>
        We'll give you an address to forward your business email to. Nothing is sent until you go
        live.
      </p>
      {setup.isError && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't set up email. Check your connection and try again.</p>
        </div>
      )}
      <div>
        <Button
          variant="primary"
          disabled={setup.isPending}
          aria-busy={setup.isPending || undefined}
          onClick={() => setup.mutate()}
        >
          {setup.isPending ? 'Setting up…' : 'Set up email'}
        </Button>
      </div>
    </section>
  );
}

const HOW_TO = [
  {
    id: 'gmail',
    label: 'Gmail',
    steps: [
      'In Gmail, open Settings, then See all settings.',
      'Open Forwarding and POP/IMAP and choose Add a forwarding address.',
      'Paste the address above. Gmail sends us a confirmation code: it shows up below.',
      'Choose "Forward a copy of incoming mail to" this address, and keep Gmail\'s copy in the Inbox.',
    ],
  },
  {
    id: 'outlook',
    label: 'Outlook',
    steps: [
      'In Outlook, open Settings, then Mail, then Forwarding.',
      'Turn on Enable forwarding.',
      'Paste the address above.',
      'Tick "Keep a copy of forwarded messages", then Save.',
    ],
  },
  {
    id: 'other',
    label: 'Other',
    steps: [
      'Set up automatic forwarding to this address in your email provider. Keep a copy in your mailbox.',
    ],
  },
] as const;

/** Card 1: the forwarding address, how-to tabs, Gmail's code and whether mail arrives. */
export function ForwardingCard({
  data,
  headingRef,
}: {
  data: EmailChannelResponse;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [tab, setTab] = useState('gmail');
  const confirmation = data.forwardingConfirmation;
  return (
    <section className="card stack email-card" aria-labelledby="email-forwarding">
      <h2 className="section-title" id="email-forwarding" tabIndex={-1} ref={headingRef}>
        1. Forward your email to us
      </h2>
      {data.forwardingAddress && (
        <CopyValue value={data.forwardingAddress} label="Copy the forwarding address" />
      )}
      <Tabs.Root className="stack" value={tab} onValueChange={setTab}>
        <Tabs.List className="tabs" aria-label="Your email provider">
          {HOW_TO.map((p) => (
            <Tabs.Trigger key={p.id} value={p.id} className="tabs__tab">
              {p.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {HOW_TO.map((p) => (
          <Tabs.Content key={p.id} value={p.id}>
            <ol className="snippet-box__steps">
              {p.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </Tabs.Content>
        ))}
      </Tabs.Root>
      {confirmation && (
        <div className="alert alert--info" data-testid="gmail-code">
          <p>
            {confirmation.code ? (
              <>
                Gmail sent a confirmation code: <strong>{confirmation.code}</strong>
              </>
            ) : (
              'Gmail sent a confirmation email.'
            )}
            {confirmation.link && (
              <>
                {' '}
                <a href={confirmation.link} target="_blank" rel="noopener noreferrer">
                  Open Gmail's confirmation link
                </a>
              </>
            )}
          </p>
          <p className="email-card__caption">Received {relativeTime(confirmation.receivedAt)}.</p>
        </div>
      )}
      <p className="email-card__status" data-testid="forwarding-status">
        {data.lastReceivedAt ? (
          <>
            <Glyph name="check" size={16} />
            Forwarding works. Last email received {relativeTime(data.lastReceivedAt)}.
          </>
        ) : (
          <>
            <Glyph name="clock" size={16} />
            Waiting for your first forwarded email.
          </>
        )}
      </p>
      <p className="email-card__caption">
        Your assistant replies for you. Reply from the KakiAgent inbox so the whole thread stays
        together.
      </p>
    </section>
  );
}

/** `dns-record-table` (design.md §4.6): a table at 640 px and wider, a list below. */
function DnsRecords({ records }: { records: readonly EmailDomainRecord[] }) {
  const rows = shownRecords(records);
  return (
    <ul className="dns-records" aria-label="DNS records">
      <li className="dns-records__head" aria-hidden="true">
        <span>Type</span>
        <span>Host</span>
        <span>Value</span>
        <span>Status</span>
      </li>
      {rows.map((r) => (
        <li className="dns-record" key={`${r.purpose}-${r.host}`} data-testid="dns-record">
          <span className="dns-record__type">{r.type}</span>
          <span className="dns-record__host">
            <code>{r.host}</code>
            <span className="email-card__caption">
              {RECORD_PURPOSE[r.purpose]}
              {r.purpose === 'dmarc' && '. You can tighten p=none later.'}
            </span>
          </span>
          <CopyValue
            className="dns-record__value"
            value={r.value}
            label={`Copy value for ${r.host}`}
          />
          <span className="dns-record__status">
            <StatusChip chip={recordStatusText(r.status)} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Card 2: the address replies come from, the custom domain and its DNS records. */
export function ReplyFromCard({
  data,
  onToast,
  onReload,
}: {
  data: EmailChannelResponse;
  onToast: Toast;
  onReload: () => void;
}) {
  const update = useEmailUpdate();
  const version = useVersion(data);
  const fieldId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Back to the email field once removing the domain has brought it back.
  const refocus = useRef(false);
  const forwarding = data.forwardingAddress ?? 'your forwarding address';
  const domain = data.domain;

  useEffect(() => {
    if (!refocus.current || domain) return;
    refocus.current = false;
    fieldRef.current?.focus();
  }, [domain]);

  const onStale = (err: unknown) => {
    if (isStale(err)) setStale(true);
    return isStale(err);
  };
  const add = useMutation({
    mutationFn: (a: string) => api.addEmailDomain({ address: a, settingsVersion: version() }),
    onMutate: () => {
      setError(null);
      setCaption(null);
    },
    onSuccess: (res) => {
      update(res);
      setAddress('');
    },
    onError: (err, a) => {
      if (!onStale(err)) setError(domainErrorText(err, a));
    },
  });
  const check = useMutation({
    mutationFn: () => api.checkEmailDomain(),
    onMutate: () => setCaption(null),
    onSuccess: (res) => {
      update(res);
      if (res.domain?.state === 'verified' && domain?.state !== 'verified')
        onToast(`${res.domain.address} is verified. Replies now come from it.`);
      else if (res.domain?.state !== 'verified')
        setCaption('Not all records are there yet. DNS changes can take up to a few hours.');
    },
    onError: (err) => {
      if (onStale(err)) return;
      if (err instanceof ApiError && err.code === 'too_soon')
        setCaption('You can check again in a few seconds.');
      else
        setCaption(domainErrorText(err, domain?.address ?? '') ?? "We couldn't check. Try again.");
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeEmailDomain(version()),
    onSuccess: (res) => {
      update(res);
      setConfirming(false);
      setCaption(null);
      refocus.current = true;
    },
    onError: (err) => {
      if (onStale(err)) setConfirming(false);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = addressError(address);
    setError(found);
    if (found) {
      fieldRef.current?.focus();
      return;
    }
    add.mutate(address.trim());
  };

  return (
    <section className="card stack email-card" aria-labelledby="email-reply-from">
      <h2 className="section-title" id="email-reply-from">
        2. The address replies come from
      </h2>
      <p>
        Replies come from <strong data-testid="reply-from">{data.replyFrom}</strong>.
      </p>
      {stale && <StaleAlert onReload={onReload} />}
      {!domain ? (
        <form className="stack" onSubmit={submit} noValidate>
          <p>
            Use your own address, like hello@yourbusiness.sg. You'll add a few DNS records so
            inboxes trust it.
          </p>
          <Field
            id={fieldId}
            label="Your business email"
            error={error ?? undefined}
            help="Must be on a domain you own, not Gmail or Outlook."
          >
            <input
              id={fieldId}
              ref={fieldRef}
              className="input"
              type="email"
              autoComplete="email"
              value={address}
              readOnly={add.isPending}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy(fieldId, error ?? undefined, true)}
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>
          <div>
            <Button
              type="submit"
              variant="secondary"
              disabled={add.isPending}
              aria-busy={add.isPending || undefined}
            >
              {add.isPending ? 'Adding…' : 'Use this address'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <div className="email-domain__head">
            <strong className="email-domain__address">{domain.address}</strong>
            <StatusChip chip={domainStateChip(domain.state)} />
          </div>
          <p className="email-card__caption">{domainMeta(domain)}</p>
          {domain.state === 'pending' && (
            <div className="alert alert--info">
              <p>
                Add these records at your domain provider. Until they check out, replies keep coming
                from {forwarding}.
              </p>
            </div>
          )}
          {domain.state === 'failing' && (
            <div className="alert alert--warning">
              <p>
                Some records are missing, so replies come from {forwarding} again. Put the records
                back, then check again.
              </p>
            </div>
          )}
          <DnsRecords records={domain.records} />
          <div className="email-domain__actions">
            <Button
              variant="secondary"
              disabled={check.isPending}
              aria-busy={check.isPending || undefined}
              onClick={() => check.mutate()}
            >
              {check.isPending ? 'Checking…' : 'Check now'}
            </Button>
            <Button
              variant="danger-ghost"
              onClick={() => {
                remove.reset();
                setConfirming(true);
              }}
            >
              Stop using this address
            </Button>
          </div>
          <p className="email-card__caption" role="status" data-testid="domain-caption">
            {caption ?? ''}
          </p>
          <ConfirmDialog
            open={confirming}
            onOpenChange={(open) => {
              if (!open) setConfirming(false);
            }}
            title={`Stop replying from ${domain.address}?`}
            confirmLabel="Stop using it"
            confirmVariant="danger"
            busy={remove.isPending}
            busyLabel="Stopping…"
            onConfirm={() => remove.mutate()}
            onCloseAutoFocus={(e) => {
              // Focus goes to the email field once it's back (the effect above).
              if (remove.isSuccess) e.preventDefault();
            }}
            alert={
              remove.isError && !isStale(remove.error) ? (
                <div className="alert alert--danger" role="alert">
                  <p>
                    {domainErrorText(remove.error, domain.address) ??
                      "We couldn't stop using it. Try again."}
                  </p>
                </div>
              ) : null
            }
          >
            <p>Replies will come from {forwarding}. You can add it again later.</p>
          </ConfirmDialog>
        </div>
      )}
    </section>
  );
}

/** Card 3: the AI reply cap and what was ignored in the last 7 days. */
export function SafetyCard({
  data,
  onToast,
  onReload,
}: {
  data: EmailChannelResponse;
  onToast: Toast;
  onReload: () => void;
}) {
  const update = useEmailUpdate();
  const version = useVersion(data);
  const fieldId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const [cap, setCap] = useState(String(data.replyCap));
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const save = useMutation({
    mutationFn: (n: number) => api.saveEmailReplyCap({ replyCap: n, settingsVersion: version() }),
    onSuccess: (res) => {
      update(res);
      setCap(String(res.replyCap));
      onToast('Saved.');
    },
    onError: (err) => {
      if (isStale(err)) setStale(true);
      else if (err instanceof ApiError && err.code === 'invalid_body') {
        setError('Enter a number from 1 to 50.');
        fieldRef.current?.focus();
      }
    },
  });
  const failed =
    save.isError &&
    !(save.error instanceof ApiError && ['stale', 'invalid_body'].includes(save.error.code));
  const changed = cap.trim() !== String(data.replyCap);
  const lines = ignoredLines(data.ignored);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = replyCapError(cap);
    setError(found);
    if (found) {
      fieldRef.current?.focus();
      return;
    }
    save.mutate(Number(cap.trim()));
  };

  return (
    <section className="card stack email-card" aria-labelledby="email-safety">
      <h2 className="section-title" id="email-safety">
        3. Stop email loops
      </h2>
      <p>
        Your assistant never answers out-of-office replies, bounces, mailing lists, bulk mail or
        spam.
      </p>
      {stale && <StaleAlert onReload={onReload} />}
      <form className="stack" onSubmit={submit} noValidate>
        <Field
          id={fieldId}
          label="AI replies per email thread"
          error={error ?? undefined}
          help="After this, the AI stops and the conversation goes to your team. Default 10."
        >
          <span className="email-cap">
            <input
              id={fieldId}
              ref={fieldRef}
              className="input email-cap__input"
              type="number"
              inputMode="numeric"
              min={REPLY_CAP_MIN}
              max={REPLY_CAP_MAX}
              value={cap}
              readOnly={save.isPending}
              aria-invalid={error ? true : undefined}
              aria-describedby={[describedBy(fieldId, error ?? undefined, true), `${fieldId}-unit`]
                .filter(Boolean)
                .join(' ')}
              onChange={(e) => setCap(e.target.value)}
            />
            <span id={`${fieldId}-unit`}>per 24 hours</span>
          </span>
        </Field>
        {failed && (
          <div className="alert alert--danger" role="alert">
            <p>We couldn't save. Check your connection and try again.</p>
          </div>
        )}
        <div>
          <Button
            type="submit"
            variant="secondary"
            disabled={!changed || save.isPending}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
      <h3 className="subsection-title">Ignored in the last 7 days</h3>
      {lines.length ? (
        <ul className="email-ignored" data-testid="ignored-mail">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="email-card__caption" data-testid="ignored-mail">
          Nothing ignored yet.
        </p>
      )}
      <p className="email-card__caption">Ignored emails are still in your own mailbox.</p>
    </section>
  );
}
