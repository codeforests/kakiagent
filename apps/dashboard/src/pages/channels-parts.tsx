import { CHANNEL_OFFLINE_TEXT_MAX, formatSgPhone, type ChannelItem } from '@kaki/contracts';
import { Button, ConfirmDialog } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { notReadyMissing } from '../lib/onboarding.ts';
import {
  channelStatus,
  CHANNELS_KEY,
  FIX_LINE,
  offlineBodyOf,
  offlineClause,
  offlineDraftOf,
  resolvedMessage,
  sameOffline,
  useChannelUpdate,
  validateOffline,
  type OfflineDraft,
  type OfflineErrors,
} from '../lib/channels.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { ErrorSummary } from './privacy-parts.tsx';

/** The parts of SCR-APP-036 Channels (FEAT-034 ui-design). */

export interface Contacts {
  email: string | null;
  phone: string | null;
}

// Decorative 16-px stroke icons (design.md §2.4, Lucide shapes); the chip text carries the meaning.
const ICONS = {
  check: 'M20 6 9 17l-5-5',
  pause: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM10 15V9M14 15V9',
  alert: 'm21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3zM12 9v4M12 17h.01',
  message: 'M7.9 20A9 9 0 1 0 4 16.1L2 22z',
} as const;

export function ChannelIcon({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

function StatusChips({ item }: { item: ChannelItem }) {
  const live = item.state === 'live';
  return (
    <span className="channel-card__chips">
      <span className={`chip ${live ? 'chip--success' : 'chip--neutral'}`}>
        <ChannelIcon name={live ? 'check' : 'pause'} />
        {live ? 'Live' : 'Offline'}
      </span>
      {item.health === 'degraded' && (
        <span className="chip chip--warning">
          <ChannelIcon name="alert" />
          Not working
        </span>
      )}
    </span>
  );
}

type Toast = (message: string) => void;

/** One channel: status, go live / go offline, the degraded alert and the offline settings. */
export function ChannelCard({
  item,
  contacts,
  onToast,
  onReload,
}: {
  item: ChannelItem;
  contacts: Contacts;
  onToast: Toast;
  onReload: () => void;
}) {
  const update = useChannelUpdate();
  const status = channelStatus(item);
  const [confirming, setConfirming] = useState(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [conflict, setConflict] = useState(false);
  // FEAT-035: a 409 `not_ready` before the first go-live; the failing item count.
  const [notReady, setNotReady] = useState<number | null>(null);
  const notReadyRef = useRef<HTMLDivElement>(null);
  const next = status.live ? 'offline' : 'live';
  const change = useMutation({
    mutationFn: () => api.setChannelState(item.id, next, item.version),
    onSuccess: (res) => {
      update(res);
      setConfirming(false);
      // Back to the card's action (now the opposite one) once the dialog has closed.
      setTimeout(() => actionRef.current?.focus());
      onToast(
        res.state === 'live' ? `Your assistant is live on ${res.name}.` : `${res.name} is offline.`,
      );
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'version_conflict') {
        setConfirming(false);
        setConflict(true);
      }
      const missing = notReadyMissing(err);
      if (missing) {
        setConfirming(false);
        setNotReady(missing.length);
        setTimeout(() => notReadyRef.current?.focus());
      }
    },
  });
  const verb = next === 'live' ? 'go live' : 'go offline';
  const headingId = useId();

  return (
    <section className="card channel-card" aria-labelledby={headingId}>
      <div className="channel-card__head">
        <span className="channel-card__icon">
          <ChannelIcon name="message" size={20} />
        </span>
        <div className="channel-card__title">
          <h2 className="section-title" id={headingId}>
            {item.name}
          </h2>
          <p className="channel-card__meta">
            {status.since}
            {status.checked && <> · {status.checked}</>}
          </p>
        </div>
        <StatusChips item={item} />
        <div className="channel-card__action">
          {status.live ? (
            <Button
              ref={actionRef}
              variant="danger-ghost"
              onClick={() => {
                change.reset();
                setConfirming(true);
              }}
            >
              Go offline
            </Button>
          ) : (
            <Button
              ref={actionRef}
              variant="primary"
              onClick={() => {
                change.reset();
                setNotReady(null);
                setConfirming(true);
              }}
            >
              Go live
            </Button>
          )}
        </div>
      </div>

      {notReady !== null && (
        <div className="alert alert--warning" role="alert" tabIndex={-1} ref={notReadyRef}>
          <p>
            Finish the go-live check first. {notReady} required {notReady === 1 ? 'item' : 'items'}{' '}
            missing.
          </p>
          <Button asChild variant="ghost">
            <Link to="/setup/go-live">Open the go-live check</Link>
          </Button>
        </div>
      )}

      {conflict && (
        <div className="alert alert--danger" role="alert">
          <p>Someone else changed this channel. Reload to see the latest.</p>
          <Button variant="secondary" onClick={onReload}>
            Reload
          </Button>
        </div>
      )}

      {status.degraded && <DegradedAlert item={item} reason={status.reason} onToast={onToast} />}

      <OfflineForm
        item={item}
        contacts={contacts}
        onToast={onToast}
        onConflict={() => setConflict(true)}
      />

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title={next === 'live' ? `Go live on ${item.name}?` : `Take ${item.name} offline?`}
        confirmLabel={next === 'live' ? 'Go live' : 'Go offline'}
        confirmVariant={next === 'live' ? 'primary' : 'danger'}
        busy={change.isPending}
        busyLabel={next === 'live' ? 'Going live…' : 'Going offline…'}
        onConfirm={() => change.mutate()}
        alert={
          change.isError && !conflict && notReady === null ? (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't {verb}. Check your connection and try again.</p>
            </div>
          ) : null
        }
      >
        {next === 'live' ? (
          <p>
            Your assistant will start answering visitors here. It answers only from facts you've
            approved, and you can go offline at any time.
          </p>
        ) : (
          <p>
            Your assistant stops answering here right away. While it's offline, visitors{' '}
            {offlineClause(item.offline.mode)}. Visitors in a chat now get your offline message.
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}

function DegradedAlert({
  item,
  reason,
  onToast,
}: {
  item: ChannelItem;
  reason: string | null;
  onToast: Toast;
}) {
  const update = useChannelUpdate();
  const [caption, setCaption] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: () => api.checkChannel(item.id),
    onMutate: () => setCaption(null),
    onSuccess: (res) => {
      update(res);
      if (res.health === 'degraded') setCaption('Still not working. Checked just now.');
      else onToast(`${res.name} is working again.`);
    },
    onError: (err) =>
      setCaption(
        err instanceof ApiError && err.status === 429
          ? 'You can check again in a few seconds.'
          : "We couldn't check. Try again.",
      ),
  });
  return (
    <div className="alert alert--warning channel-card__degraded">
      <p className="alert__title">This channel isn't working</p>
      <p>
        {reason} {FIX_LINE}
      </p>
      {item.checksHealth && (
        <Button
          variant="secondary"
          className="kaki-btn--sm"
          disabled={check.isPending}
          aria-busy={check.isPending || undefined}
          onClick={() => check.mutate()}
        >
          {check.isPending ? 'Checking…' : 'Check again'}
        </Button>
      )}
      {caption && (
        <p className="channel-card__caption" role="status">
          {caption}
        </p>
      )}
    </div>
  );
}

const MODE_COPY = {
  hidden: ['Hide the chat button', "Visitors don't see the chat on your website."],
  message: [
    'Show a message',
    "Visitors see the chat button, your message and your contact details, but can't chat.",
  ],
} as const;

/** "While it's offline": the mode, the two texts, the contact line and the preview. */
function OfflineForm({
  item,
  contacts,
  onToast,
  onConflict,
}: {
  item: ChannelItem;
  contacts: Contacts;
  onToast: Toast;
  onConflict: () => void;
}) {
  const queryClient = useQueryClient();
  const update = useChannelUpdate();
  const prefix = `offline-${item.id}`;
  const [draft, setDraft] = useState<OfflineDraft>(() => offlineDraftOf(item));
  const [errors, setErrors] = useState<OfflineErrors>({});
  const [focusKey, setFocusKey] = useState(0);
  const save = useMutation({
    // The version is read at save time: going live or offline bumps it too.
    mutationFn: (d: OfflineDraft) => {
      const latest =
        queryClient
          .getQueryData<{ channels: ChannelItem[] }>(CHANNELS_KEY)
          ?.channels.find((c) => c.id === item.id) ?? item;
      return api.saveChannelOffline(item.id, offlineBodyOf(d, latest.version));
    },
    onSuccess: (res) => {
      update(res);
      setDraft(offlineDraftOf(res));
      onToast(`Saved. Visitors see this while ${res.name} is offline.`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'version_conflict') onConflict();
      else if (err instanceof ApiError && err.code === 'invalid_body') {
        const fields = (err.details.fields ?? {}) as Record<string, string>;
        const server: OfflineErrors = {};
        if (fields.mode) server.mode = 'Choose what visitors see.';
        for (const k of ['en', 'zh'] as const)
          if (fields[`message.${k}`])
            server[k] = `Keep the message under ${CHANNEL_OFFLINE_TEXT_MAX} characters.`;
        setErrors(server);
        setFocusKey((n) => n + 1);
      }
    },
  });
  const changed = !sameOffline(draft, offlineDraftOf(item));
  const failed =
    save.isError &&
    !(
      save.error instanceof ApiError &&
      ['version_conflict', 'invalid_body'].includes(save.error.code)
    );
  const preview = resolvedMessage(draft, item);
  const set = (patch: Partial<OfflineDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateOffline(draft, item);
    setErrors(found);
    if (Object.keys(found).length) {
      setFocusKey((n) => n + 1);
      return;
    }
    save.mutate(draft);
  };

  const textField = (k: 'en' | 'zh', label: string, help: string) => {
    const id = `${prefix}-${k}`;
    const n = draft[k].trim().length;
    return (
      <Field id={id} label={label} error={errors[k]} help={help}>
        <textarea
          id={id}
          className="input input--area"
          rows={3}
          value={draft[k]}
          placeholder={item.offline.defaults[k]}
          readOnly={save.isPending}
          aria-invalid={errors[k] ? true : undefined}
          aria-describedby={[describedBy(id, errors[k], true), `${id}-count`]
            .filter(Boolean)
            .join(' ')}
          onChange={(e) => set({ [k]: e.target.value })}
        />
        <p className="field__counter" id={`${id}-count`}>
          {n} / {CHANNEL_OFFLINE_TEXT_MAX}
        </p>
      </Field>
    );
  };

  return (
    <form className="channel-offline" onSubmit={submit} noValidate>
      <h3 className="channel-offline__title">While it's offline</h3>
      <ErrorSummary errors={errors} prefix={prefix} focusKey={focusKey} />
      <fieldset className="radio-group" id={`${prefix}-mode`} tabIndex={-1}>
        <legend className="field__label">What visitors see</legend>
        {item.offlineModes.map((mode) => (
          <label className="radio channel-offline__mode" key={mode}>
            <input
              type="radio"
              name={`${prefix}-mode`}
              checked={draft.mode === mode}
              disabled={save.isPending}
              aria-describedby={`${prefix}-${mode}-help`}
              onChange={() => set({ mode })}
            />
            <span>
              <span className="channel-offline__mode-label">{MODE_COPY[mode][0]}</span>
              <span className="field__help" id={`${prefix}-${mode}-help`}>
                {MODE_COPY[mode][1]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {draft.mode === 'message' && (
        <>
          {textField(
            'en',
            'Message (English)',
            `Leave empty to use: “${item.offline.defaults.en}”`,
          )}
          {textField(
            'zh',
            'Message (中文)',
            'Shown to visitors whose browser is set to Chinese. Leave empty to use the default.',
          )}
          <p className="channel-offline__contact">
            {contacts.email || contacts.phone
              ? `Visitors also see ${[
                  contacts.email,
                  contacts.phone && formatSgPhone(contacts.phone),
                ]
                  .filter(Boolean)
                  .join(' and ')} from your Business profile. `
              : 'Add an email or phone in your Business profile so visitors can reach you. '}
            <Link to="/settings/business-profile">Business profile</Link>
          </p>
          <div className="channel-preview" role="region" aria-label="What visitors see">
            <p>{preview.en}</p>
            {contacts.email && <p>Email: {contacts.email}</p>}
            {contacts.phone && <p>Phone: {formatSgPhone(contacts.phone)}</p>}
          </div>
        </>
      )}

      {failed && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't save. Check your connection and try again.</p>
        </div>
      )}
      <div className="privacy-form__actions">
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
  );
}
