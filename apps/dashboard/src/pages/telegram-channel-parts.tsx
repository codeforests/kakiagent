import type { TelegramChannelResponse, TelegramLinkStart } from '@kaki/contracts';
import { Button, ConfirmDialog, FormDialog } from '@kaki/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type Ref, type RefObject } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { Field } from '../lib/field.tsx';
import { describedBy } from '../lib/form.ts';
import { NOTIFICATIONS_KEY, useNotificationPrefs } from '../lib/notifications.ts';
import {
  alertMembersText,
  degradedCopy,
  ignoredLines,
  lastReceivedText,
  linkedText,
  linkView,
  LINK_POLL_MS,
  needsReload,
  TELEGRAM_CHANNEL_KEY,
  telegramErrorText,
  tokenError,
  useTelegramUpdate,
} from '../lib/telegram-channel.ts';
import { Glyph } from './conversation-parts.tsx';

/** The parts of SCR-APP-039 Telegram (FEAT-037 ui-design). */

type Toast = (message: string) => void;

export function StaleAlert({ onReload }: { onReload: () => void }) {
  return (
    <div className="alert alert--warning" role="alert" data-testid="telegram-stale">
      <p>Someone else changed this. Reload to see the latest.</p>
      <Button variant="secondary" onClick={onReload}>
        Reload
      </Button>
    </div>
  );
}

/** The token input shared by Connect and Replace: mono, no autocomplete or spellcheck. */
function TokenField({
  id,
  value,
  onChange,
  error,
  busy,
  inputRef,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  busy: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <Field
      id={id}
      label="Bot token"
      error={error ?? undefined}
      help="We store it encrypted. Anyone with this token can control your bot, so don't share it elsewhere."
    >
      <input
        id={id}
        ref={inputRef}
        className="input telegram-token"
        type="text"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        value={value}
        readOnly={busy}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error ?? undefined, true)}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** Not connected: BotFather steps and the token form. */
export function ConnectBot({
  onDone,
  onReload,
  fieldRef,
}: {
  onDone: (res: TelegramChannelResponse) => void;
  onReload: () => void;
  fieldRef: RefObject<HTMLInputElement | null>;
}) {
  const update = useTelegramUpdate();
  const fieldId = useId();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const connect = useMutation({
    mutationFn: () => api.connectTelegram(token.trim()),
    onSuccess: (res) => {
      update(res);
      onDone(res);
    },
    onError: (err) => {
      if (needsReload(err)) setStale(true);
      else {
        setError(telegramErrorText(err));
        fieldRef.current?.focus();
      }
    },
  });
  return (
    <section className="card stack telegram-card" aria-labelledby="telegram-connect">
      <h2 className="section-title" id="telegram-connect">
        Connect your bot
      </h2>
      <ol className="telegram-steps">
        <li>
          In Telegram, open{' '}
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
            @BotFather<span className="sr-only"> (opens Telegram)</span>
          </a>{' '}
          and send /newbot.
        </li>
        <li>Pick a name and a username ending in “bot”.</li>
        <li>BotFather sends you a token like 123456789:AA… Copy it.</li>
        <li>Paste it below.</li>
      </ol>
      {stale && <StaleAlert onReload={onReload} />}
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const own = tokenError(token);
          setError(own);
          if (own) fieldRef.current?.focus();
          else connect.mutate();
        }}
      >
        <TokenField
          id={fieldId}
          value={token}
          onChange={setToken}
          error={error}
          busy={connect.isPending}
          inputRef={fieldRef}
        />
        <div>
          <Button
            type="submit"
            disabled={connect.isPending}
            aria-busy={connect.isPending || undefined}
          >
            {connect.isPending ? 'Connecting…' : 'Connect bot'}
          </Button>
        </div>
      </form>
    </section>
  );
}

function HealthChip({ health }: { health: 'ok' | 'degraded' | 'unknown' }) {
  if (health === 'unknown') return null;
  const ok = health === 'ok';
  return (
    <span className={`chip ${ok ? 'chip--success' : 'chip--danger'} email-chip`}>
      <Glyph name={ok ? 'check' : 'x-circle'} size={14} />
      {ok ? 'Working' : 'Not working'}
    </span>
  );
}

/** The degraded alert at the top of the bot card, by reason, with its action. */
function DegradedAlert({
  data,
  onReplace,
  onToast,
}: {
  data: TelegramChannelResponse;
  onReplace: () => void;
  onToast: Toast;
}) {
  const queryClient = useQueryClient();
  const copy = degradedCopy(data.connection?.healthReason ?? null);
  const [caption, setCaption] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: () => api.checkChannel(data.connection!.id),
    onMutate: () => setCaption(null),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: TELEGRAM_CHANNEL_KEY });
      if (res.health === 'degraded') setCaption('Still not working.');
      else onToast('Telegram is working again.');
    },
    onError: (err) =>
      setCaption(
        err instanceof ApiError && err.status === 429
          ? 'You can check again in a few seconds.'
          : "We couldn't check. Try again.",
      ),
  });
  return (
    <div className="alert alert--danger stack" data-testid="telegram-degraded">
      <p>{copy.text}</p>
      <div>
        {copy.action === 'replace' ? (
          <Button className="kaki-btn--sm" onClick={onReplace}>
            Replace token
          </Button>
        ) : (
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
      </div>
      {caption && (
        <p className="email-card__caption" role="status">
          {caption}
        </p>
      )}
    </div>
  );
}

/** Connected: the bot, its status, the private-chats note, what was ignored and the actions. */
export function BotCard({
  data,
  headingRef,
  onToast,
  onReload,
  onDisconnected,
}: {
  data: TelegramChannelResponse;
  headingRef: Ref<HTMLHeadingElement>;
  onToast: Toast;
  onReload: () => void;
  onDisconnected: () => void;
}) {
  const update = useTelegramUpdate();
  const bot = data.bot!;
  const [replacing, setReplacing] = useState(false);
  // A fresh dialog (empty field, no error) on each opening.
  const [replaceKey, setReplaceKey] = useState(0);
  const openReplace = () => {
    setReplaceKey((k) => k + 1);
    setReplacing(true);
  };
  const [confirming, setConfirming] = useState(false);
  const [stale, setStale] = useState(false);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const disconnect = useMutation({
    mutationFn: () => api.disconnectTelegram(data.settingsVersion),
    onSuccess: (res) => {
      setConfirming(false);
      update(res);
      onDisconnected();
    },
    onError: (err) => {
      if (needsReload(err)) {
        setConfirming(false);
        setStale(true);
      }
    },
  });
  const lines = ignoredLines(data.ignored);
  const degraded = data.connection?.health === 'degraded';
  return (
    <section className="card stack telegram-card" aria-labelledby="telegram-bot">
      {degraded && <DegradedAlert data={data} onReplace={openReplace} onToast={onToast} />}
      <h2 className="section-title" id="telegram-bot" tabIndex={-1} ref={headingRef}>
        {bot.name}
      </h2>
      <p className="telegram-bot">
        <Glyph name="send" size={20} />
        <strong data-testid="telegram-username">@{bot.username}</strong>
        <a href={bot.link} target="_blank" rel="noreferrer">
          Open in Telegram<span className="sr-only"> (opens Telegram)</span>
        </a>
        {data.connection && <HealthChip health={data.connection.health} />}
      </p>
      <p className="email-card__status" data-testid="telegram-last">
        <Glyph name={data.lastReceivedAt ? 'check' : 'clock'} size={14} />
        {lastReceivedText(data)}
      </p>
      <div className="alert alert--info telegram-note">
        <Glyph name="users" size={20} />
        <p>
          Your bot answers private messages only. If someone adds it to a group, it says so once and
          leaves. To stop that, send /setjoingroups to @BotFather and choose Disable.
        </p>
      </div>
      <div className="stack">
        <h3 className="telegram-ignored__title">Ignored in the last 7 days</h3>
        {lines.length ? (
          <ul className="telegram-ignored" data-testid="telegram-ignored">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="email-card__caption">Nothing ignored yet.</p>
        )}
      </div>
      {stale && <StaleAlert onReload={onReload} />}
      <div className="email-domain__actions">
        <Button ref={replaceRef} variant="secondary" onClick={openReplace}>
          Replace token
        </Button>
        <Button
          variant="danger-ghost"
          onClick={() => {
            disconnect.reset();
            setConfirming(true);
          }}
        >
          Disconnect bot
        </Button>
      </div>
      <ReplaceDialog
        key={replaceKey}
        open={replacing}
        data={data}
        onClose={(done) => {
          setReplacing(false);
          if (done) onToast('Token replaced.');
        }}
        onStale={() => setStale(true)}
        returnFocus={replaceRef}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title={`Disconnect @${bot.username}?`}
        confirmLabel="Disconnect"
        confirmVariant="danger"
        busy={disconnect.isPending}
        busyLabel="Disconnecting…"
        onConfirm={() => disconnect.mutate()}
        onCloseAutoFocus={(e) => {
          // Focus goes to the token field once it's back (the page's effect).
          if (disconnect.isSuccess) e.preventDefault();
        }}
        alert={
          disconnect.isError && !needsReload(disconnect.error) ? (
            <div className="alert alert--danger" role="alert">
              <p>{telegramErrorText(disconnect.error) ?? "We couldn't disconnect. Try again."}</p>
            </div>
          ) : null
        }
      >
        <p>
          Your assistant stops answering on Telegram, and your team's Telegram alerts stop. Past
          conversations stay in the inbox.
        </p>
      </ConfirmDialog>
    </section>
  );
}

function ReplaceDialog({
  open,
  data,
  onClose,
  onStale,
  returnFocus,
}: {
  open: boolean;
  data: TelegramChannelResponse;
  onClose: (done: boolean) => void;
  onStale: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const update = useTelegramUpdate();
  const fieldId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const replace = useMutation({
    mutationFn: () => api.replaceTelegramToken(token.trim(), data.settingsVersion),
    onSuccess: (res) => {
      update(res);
      onClose(true);
    },
    onError: (err) => {
      if (needsReload(err)) {
        onClose(false);
        onStale();
      } else {
        setError(telegramErrorText(err));
        fieldRef.current?.focus();
      }
    },
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose(false);
      }}
      title="Replace the bot token"
      busy={replace.isPending}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        returnFocus.current?.focus();
      }}
    >
      <form
        className="team-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const own = tokenError(token);
          setError(own);
          if (own) fieldRef.current?.focus();
          else replace.mutate();
        }}
      >
        <p>Use this after you send /revoke to @BotFather. It must be for @{data.bot?.username}.</p>
        <TokenField
          id={fieldId}
          value={token}
          onChange={setToken}
          error={error}
          busy={replace.isPending}
          inputRef={fieldRef}
        />
        <div className="kaki-dialog__actions">
          <Button
            type="button"
            variant="secondary"
            disabled={replace.isPending}
            onClick={() => onClose(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={replace.isPending}
            aria-busy={replace.isPending || undefined}
          >
            {replace.isPending ? 'Replacing…' : 'Replace'}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

/**
 * "Get your alerts on Telegram": the signed-in member's own link (D1), for every role. While a
 * start link is open the page re-reads the preferences every 3 s until the webhook links it.
 */
export function AlertsCard({
  alertMembers,
  onToast,
}: {
  /** Owner/Admin only: how many people on the team linked Telegram. */
  alertMembers: number | null;
  onToast: Toast;
}) {
  const queryClient = useQueryClient();
  const prefs = useNotificationPrefs();
  const link = prefs.data?.sendTo.telegram ?? null;
  const [started, setStarted] = useState<TelegramLinkStart | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const view = link ? linkView(link, started, now) : null;
  const waiting = view?.kind === 'pending';

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      setNow(new Date());
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    }, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, queryClient]);

  const wasLinked = useRef(link?.state === 'linked');
  useEffect(() => {
    const linked = link?.state === 'linked';
    if (linked && !wasLinked.current) {
      setStarted(null);
      onToast('Telegram linked. Alerts will arrive there too.');
      headingRef.current?.focus();
    }
    wasLinked.current = linked;
  }, [link?.state, onToast]);

  const start = useMutation({
    mutationFn: api.startTelegramLink,
    onMutate: () => setError(null),
    onSuccess: (res) => {
      setNow(new Date());
      setStarted(res);
    },
    onError: () => setError("We couldn't get a link. Try again."),
  });
  const unlink = useMutation({
    mutationFn: api.unlinkTelegram,
    onMutate: () => setError(null),
    onSuccess: async () => {
      wasLinked.current = false;
      await queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      onToast('Telegram alerts stopped.');
    },
    onError: () => setError("We couldn't unlink. Try again."),
  });

  if (!link || !view) return null;
  return (
    <section
      className="card stack telegram-card"
      aria-labelledby="telegram-alerts"
      id="alerts"
      data-testid="telegram-alerts"
    >
      <h2
        className="section-title telegram-heading"
        id="telegram-alerts"
        tabIndex={-1}
        ref={headingRef}
      >
        <Glyph name="bell" size={20} />
        Get your alerts on Telegram
      </h2>
      {view.kind === 'not_linked' && (
        <>
          <p>Get escalations, approvals and hot leads on Telegram as well as by email.</p>
          <div>
            <Button
              variant="secondary"
              disabled={start.isPending}
              aria-busy={start.isPending || undefined}
              onClick={() => start.mutate()}
            >
              {start.isPending ? 'Getting link…' : 'Link my Telegram'}
            </Button>
          </div>
          {view.expired && (
            <p className="email-card__caption" role="status">
              The link expired. Get a new one.
            </p>
          )}
        </>
      )}
      {view.kind === 'pending' && (
        <>
          <p>Open the link and press Start in Telegram.</p>
          <div>
            {view.url ? (
              <Button asChild>
                <a href={view.url} target="_blank" rel="noreferrer" data-testid="telegram-link">
                  Open Telegram<span className="sr-only"> (opens Telegram)</span>
                </a>
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={start.isPending}
                aria-busy={start.isPending || undefined}
                onClick={() => start.mutate()}
              >
                {start.isPending ? 'Getting link…' : 'Get a new link'}
              </Button>
            )}
          </div>
          <p className="email-card__caption">The link works for 15 minutes.</p>
        </>
      )}
      {view.kind === 'linked' && (
        <>
          <p data-testid="telegram-linked">{linkedText(view.name, view.linkedAt)}</p>
          <div className="email-domain__actions">
            <Link to="/account/notifications">Choose which alerts</Link>
            <Button
              variant="ghost"
              disabled={unlink.isPending}
              aria-busy={unlink.isPending || undefined}
              onClick={() => unlink.mutate()}
            >
              Unlink
            </Button>
          </div>
        </>
      )}
      {error && (
        <div className="alert alert--danger" role="alert">
          <p>{error}</p>
        </div>
      )}
      {alertMembers !== null && (
        <p className="email-card__caption" data-testid="telegram-alert-members">
          {alertMembersText(alertMembers)}
        </p>
      )}
    </section>
  );
}
