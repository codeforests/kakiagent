import { Button, ErrorState } from '@kaki/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import { useNotificationPrefs } from '../lib/notifications.ts';
import { TELEGRAM_CHANNEL_KEY, useTelegramChannel } from '../lib/telegram-channel.ts';
import { AlertsCard, BotCard, ConnectBot } from './telegram-channel-parts.tsx';

/** SCR-APP-039 Telegram (CHN-05, CHN-12, LED-04; FEAT-037 ui-design). */
export function TelegramChannelPage() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useToast();
  const [generation, setGeneration] = useState(0);
  // After connect focus goes to the bot card's heading; after disconnect, to the token field.
  const focusNext = useRef<'bot' | 'token' | null>(null);
  const botRef = useRef<HTMLHeadingElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const loaded = useTelegramChannel();
  const prefs = useNotificationPrefs();
  const reload = () =>
    void queryClient
      .invalidateQueries({ queryKey: TELEGRAM_CHANNEL_KEY })
      .then(() => setGeneration((g) => g + 1));

  const connected = loaded.data?.connected;
  useEffect(() => {
    if (connected === true && focusNext.current === 'bot') botRef.current?.focus();
    else if (connected === false && focusNext.current === 'token') tokenRef.current?.focus();
    else return;
    focusNext.current = null;
  }, [connected]);

  const agent = loaded.error instanceof ApiError && loaded.error.status === 403;
  let body;
  if (agent)
    // An Agent sees only their own alert link (tech design §3: the link routes are every member's).
    body = prefs.data?.sendTo.telegram ? (
      <div className="stack">
        <AlertsCard alertMembers={null} onToast={setToast} />
        <p className="email-card__caption">Only the Owner and Admins can change the bot.</p>
      </div>
    ) : prefs.data ? (
      <p>Your business hasn't connected a Telegram bot. Only the Owner and Admins can do that.</p>
    ) : null;
  else if (loaded.isError)
    body = (
      <ErrorState
        title="We couldn't load your Telegram settings."
        action={
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Try again
          </Button>
        }
      />
    );
  else if (!loaded.data)
    body = (
      <div className="stack" aria-busy="true" aria-label="Loading Telegram settings">
        {[0, 1].map((k) => (
          <div className="card" key={k}>
            <div className="skeleton-field" />
            <div className="skeleton-field" />
          </div>
        ))}
      </div>
    );
  else if (!loaded.data.connected)
    body = (
      <ConnectBot
        key={generation}
        fieldRef={tokenRef}
        onReload={reload}
        onDone={(res) => {
          focusNext.current = 'bot';
          setToast(
            `@${res.bot?.username ?? 'Your bot'} is connected. Go live on Channels when you're ready.`,
          );
        }}
      />
    );
  else
    body = (
      <div className="stack" key={generation}>
        <BotCard
          data={loaded.data}
          headingRef={botRef}
          onToast={setToast}
          onReload={reload}
          onDisconnected={() => {
            focusNext.current = 'token';
            setToast('Bot disconnected.');
          }}
        />
        <AlertsCard alertMembers={loaded.data.alertMembers} onToast={setToast} />
      </div>
    );

  const state = loaded.data?.connection?.state;
  return (
    <div className="channels-page email-page">
      <nav aria-label="Breadcrumb">
        <ol className="email-breadcrumb">
          <li>
            <Link to="/settings">Settings</Link>
          </li>
          <li>
            <Link to="/settings/channels">Channels</Link>
          </li>
          <li aria-current="page">Telegram</li>
        </ol>
      </nav>
      <h1 className="page-title">Telegram</h1>
      <p className="page-lede">
        Your assistant answers customers who message your Telegram bot, from your approved facts.
      </p>
      {state && (
        <p className="email-page__status" data-testid="telegram-status">
          Status: {state === 'live' ? 'Live' : 'Offline'} · Change it on{' '}
          <Link to="/settings/channels">Channels</Link>.
        </p>
      )}
      {body}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
