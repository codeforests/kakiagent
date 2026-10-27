import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { CHANNELS_KEY, useChannels } from '../lib/channels.ts';
import { useToast } from '../lib/form.ts';
import { ChannelCard, type Contacts } from './channels-parts.tsx';

/** SCR-APP-036 Channels (ONB-10, CHN-12; FEAT-034 ui-design). */
export function ChannelsPage() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useToast();
  const [generation, setGeneration] = useState(0);
  const loaded = useChannels();
  const profile = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => api.businessProfile(),
    retry: false,
  });
  const contacts: Contacts = {
    email: profile.data?.profile.contactEmail ?? null,
    phone: profile.data?.profile.contactPhone ?? null,
  };
  const reload = () =>
    void queryClient
      .invalidateQueries({ queryKey: CHANNELS_KEY })
      .then(() => setGeneration((g) => g + 1));

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
        title="We couldn't load your channels."
        action={
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Try again
          </Button>
        }
      />
    );
  else if (!loaded.data)
    body = (
      <div className="card" aria-busy="true" aria-label="Loading channels">
        <div className="skeleton-field" />
        <div className="skeleton-field" />
      </div>
    );
  else
    body = (
      <div className="stack">
        {loaded.data.channels.map((item) => (
          <ChannelCard
            key={`${item.id}-${generation}`}
            item={item}
            contacts={contacts}
            onToast={setToast}
            onReload={reload}
          />
        ))}
        {loaded.data.connectable.length > 0 && (
          <section className="card stack" aria-labelledby="channels-connect">
            <h2 className="section-title" id="channels-connect">
              Connect a channel
            </h2>
            <div className="channels-connect">
              {loaded.data.connectable.map((c) => (
                <Button asChild variant="secondary" key={c.kind}>
                  <Link to={c.connectPath}>{c.name}</Link>
                </Button>
              ))}
            </div>
          </section>
        )}
      </div>
    );

  return (
    <div className="channels-page">
      <Link className="back-link" to="/settings">
        Settings
      </Link>
      <h1 className="page-title">Channels</h1>
      <p className="page-lede">
        Where your assistant answers visitors. Your assistant never replies on a channel that's
        offline.
      </p>
      {body}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
