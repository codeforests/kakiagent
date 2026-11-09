import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api.ts';
import { EMAIL_CHANNEL_KEY, useEmailChannel } from '../lib/email-channel.ts';
import { useToast } from '../lib/form.ts';
import { ForwardingCard, ReplyFromCard, SafetyCard, SetUpEmail } from './email-channel-parts.tsx';

/** SCR-APP-038 Email channel (CHN-04, CHN-10, NFR-18; FEAT-036 ui-design). */
export function EmailChannelPage() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useToast();
  const [generation, setGeneration] = useState(0);
  // Focus moves to the forwarding card once setup's answer has rendered it.
  const focusForwarding = useRef(false);
  const forwardingRef = useRef<HTMLHeadingElement>(null);
  const loaded = useEmailChannel();
  const reload = () =>
    void queryClient
      .invalidateQueries({ queryKey: EMAIL_CHANNEL_KEY })
      .then(() => setGeneration((g) => g + 1));

  const connected = loaded.data?.connected ?? false;
  useEffect(() => {
    if (!focusForwarding.current || !connected) return;
    focusForwarding.current = false;
    forwardingRef.current?.focus();
  }, [connected]);

  let body;
  if (loaded.error instanceof ApiError && loaded.error.status === 403)
    body = (
      <EmptyState title="You can't change channels">
        Only the Owner and Admins can change channels.
      </EmptyState>
    );
  else if (loaded.isError)
    body = (
      <ErrorState
        title="We couldn't load your email settings."
        action={
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Try again
          </Button>
        }
      />
    );
  else if (!loaded.data)
    body = (
      <div className="stack" aria-busy="true" aria-label="Loading email settings">
        {[0, 1, 2].map((k) => (
          <div className="card" key={k}>
            <div className="skeleton-field" />
            <div className="skeleton-field" />
          </div>
        ))}
      </div>
    );
  else if (!loaded.data.connected)
    body = (
      <SetUpEmail
        onDone={() => {
          focusForwarding.current = true;
          setToast('Email is set up. Next, forward your mail.');
        }}
      />
    );
  else
    body = (
      <div className="stack" key={generation}>
        <ForwardingCard data={loaded.data} headingRef={forwardingRef} />
        <ReplyFromCard data={loaded.data} onToast={setToast} onReload={reload} />
        <SafetyCard data={loaded.data} onToast={setToast} onReload={reload} />
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
          <li aria-current="page">Email</li>
        </ol>
      </nav>
      <h1 className="page-title">Email</h1>
      <p className="page-lede">
        Your assistant answers customer emails from your approved facts, in the same email thread.
      </p>
      {state && (
        <p className="email-page__status" data-testid="email-status">
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
