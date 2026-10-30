import type { TeamMfa } from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState, ErrorState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import { TEAM_MFA_KEY, useMfaStatus, useTeamMfa } from '../lib/mfa.ts';
import { ReauthCancelled, useReauthGuard } from '../lib/reauth.ts';

/**
 * SCR-APP-045 Team, its two-step part (FEAT-006 ui-design): the Owner requires two-step
 * verification for everyone. FEAT-007 adds members, roles and invitations.
 */
export function TeamPage() {
  const team = useTeamMfa();
  const [toast, setToast] = useToast();
  return (
    <>
      <h1 className="page-title">Team</h1>
      {team.isError ? (
        <ErrorState
          title="We couldn't load your team's two-step setting."
          action={
            <Button variant="secondary" onClick={() => void team.refetch()}>
              Try again
            </Button>
          }
        />
      ) : team.data ? (
        <RequireCard team={team.data} onToast={setToast} />
      ) : (
        <div
          className="card two-step-card"
          aria-busy="true"
          aria-label="Loading two-step verification"
        >
          <div className="skeleton-field" />
        </div>
      )}
      <EmptyState title="Not built yet">
        Members, roles and invitations arrive here soon, with FEAT-007.
      </EmptyState>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

function RequireCard({ team, onToast }: { team: TeamMfa; onToast: (t: string) => void }) {
  const queryClient = useQueryClient();
  const { guard } = useReauthGuard();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const mine = useMfaStatus();
  const [asking, setAsking] = useState<boolean | null>(null);
  const change = useMutation({
    mutationFn: (required: boolean) => guard(() => api.setTeamMfa(required)),
    onSuccess: (res) => {
      queryClient.setQueryData<TeamMfa>(TEAM_MFA_KEY, res);
      setAsking(null);
      onToast(
        res.required
          ? 'Two-step verification is now required.'
          : 'Two-step verification is no longer required.',
      );
    },
  });

  const owner = me.data?.role === 'owner';
  const workspace = me.data?.tenant?.name ?? 'your workspace';
  const notEnrolled =
    !team.required &&
    (mine.data?.enrolled === false ||
      (change.error instanceof ApiError && change.error.code === 'mfa_not_enrolled'));
  const readOnly = !owner;
  const disabled = owner && notEnrolled;
  const missing = team.members - team.enrolled;
  const failed =
    change.isError &&
    !(change.error instanceof ReauthCancelled) &&
    !(change.error instanceof ApiError && change.error.code === 'mfa_not_enrolled');

  const counts = `${team.enrolled} of ${team.members} members use it.`;

  return (
    <section className="card two-step-card" aria-labelledby="team-mfa-title">
      <h2 className="section-title" id="team-mfa-title">
        Two-step verification
      </h2>
      <div className="team-mfa__row">
        <button
          type="button"
          role="switch"
          className="toggle"
          aria-checked={team.required}
          aria-labelledby="team-mfa-label"
          aria-describedby="team-mfa-help"
          aria-disabled={readOnly || undefined}
          aria-busy={change.isPending || undefined}
          disabled={disabled || change.isPending}
          onClick={() => {
            if (readOnly) return;
            change.reset();
            setAsking(!team.required);
          }}
        >
          <span className="toggle__thumb" aria-hidden="true" />
        </button>
        <span id="team-mfa-label">Require two-step verification for everyone in {workspace}</span>
        {change.isPending && <span className="spinner spinner--sm" aria-hidden="true" />}
      </div>
      <p className="field__help" id="team-mfa-help">
        {disabled ? (
          <>
            Set up two-step verification for yourself first.{' '}
            <Link to="/two-step/setup">Set up</Link>
          </>
        ) : readOnly ? (
          `Only the Owner can change this. ${counts}`
        ) : (
          counts
        )}
      </p>

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={asking ? 'Require two-step verification?' : 'Stop requiring two-step verification?'}
        confirmLabel={asking ? 'Require it' : 'Stop requiring'}
        busy={change.isPending}
        busyLabel="Saving…"
        onConfirm={() => asking !== null && change.mutate(asking)}
        alert={
          failed && (
            <div className="alert alert--danger" role="alert">
              <p>We couldn't change this. Check your connection and try again.</p>
            </div>
          )
        }
      >
        {asking
          ? missing > 0
            ? `${missing} ${missing === 1 ? "member who hasn't" : "members who haven't"} set it up will have to before they can use the dashboard again.`
            : 'Everyone already uses it.'
          : 'Members can turn it off for themselves.'}
      </ConfirmDialog>
    </section>
  );
}
