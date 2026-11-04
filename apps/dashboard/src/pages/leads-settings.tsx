import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import { LEADS_KEY, useLeadSettings } from '../lib/leads.ts';
import { LeadSettingsForm } from './leads-settings-parts.tsx';

/** SCR-APP-043 Leads and consent: lead fields and the marketing opt-in (FEAT-049 ui-design). */
export function LeadsSettingsPage() {
  const [toast, setToast] = useToast();
  const queryClient = useQueryClient();
  const [generation, setGeneration] = useState(0);
  const loaded = useLeadSettings();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const business = me.data?.tenant?.name ?? 'us';
  const reload = () =>
    void queryClient
      .invalidateQueries({ queryKey: LEADS_KEY })
      .then(() => setGeneration((g) => g + 1));

  let body;
  if (loaded.error instanceof ApiError && loaded.error.status === 403)
    body = (
      <EmptyState title="You can't change lead settings">
        Only the Owner and Admins can change lead settings.
      </EmptyState>
    );
  else if (loaded.isError)
    body = (
      <ErrorState
        title="Couldn't load lead settings"
        action={
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Try again
          </Button>
        }
      />
    );
  else if (!loaded.data || !me.data)
    body = (
      <div className="stack" aria-busy="true" aria-label="Loading lead settings">
        {[0, 1].map((k) => (
          <div className="card" key={k}>
            <div className="skeleton-field" />
            <div className="skeleton-field" />
          </div>
        ))}
      </div>
    );
  else
    body = (
      <LeadSettingsForm
        key={generation}
        data={loaded.data}
        business={business}
        onReload={reload}
        onToast={setToast}
      />
    );

  return (
    <div className="leads-page">
      <Link className="back-link" to="/settings">
        Settings
      </Link>
      <h1 className="page-title">Leads and consent</h1>
      {body}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
