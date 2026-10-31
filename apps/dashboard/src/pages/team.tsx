import type { MemberPatch, Role, TeamInvitation, TeamMember, TeamMfa } from '@kaki/contracts';
import { Button, ConfirmDialog, EmptyState, ErrorState } from '@kaki/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import { TEAM_MFA_KEY, useMfaStatus, useTeamMfa } from '../lib/mfa.ts';
import { ReauthCancelled, useReauthGuard } from '../lib/reauth.ts';
import {
  memberActions,
  roleLabel,
  useInvite,
  useResend,
  useRevoke,
  useTeam,
  useUpdateMember,
  withArticle,
  type MemberAction,
} from '../lib/team.ts';
import { InvitationsSection, InviteDialog, MembersSection, RoleDialog } from './team-parts.tsx';

/**
 * SCR-APP-045 Team (FEAT-006, FEAT-007 ui-design): members with their roles and approval
 * rights, invitations, and the Owner's two-step requirement below. Agents see only the
 * two-step card, read-only (the team routes answer them 403).
 */
export function TeamPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const manage = me.data?.role === 'owner' || me.data?.role === 'admin';
  const teamMfa = useTeamMfa();
  const [toast, setToast] = useToast();
  const inviteRef = useRef<HTMLButtonElement>(null);
  const [inviting, setInviting] = useState(false);
  return (
    <>
      <div className="page-header team-header">
        <div className="page-header__text">
          <h1 className="page-title">Team</h1>
          <p className="page-lede">Invite your staff and choose what each person can do.</p>
        </div>
        {manage && (
          <Button ref={inviteRef} onClick={() => setInviting(true)}>
            Invite someone
          </Button>
        )}
      </div>
      {me.data && !manage && (
        <div className="alert alert--info">
          <p>Only the Owner and Admins can manage the team.</p>
        </div>
      )}
      {manage && (
        <TeamManager
          viewer={me.data!.role}
          workspace={me.data?.tenant?.name ?? 'your workspace'}
          inviting={inviting}
          setInviting={setInviting}
          inviteRef={inviteRef}
          onToast={setToast}
        />
      )}
      {teamMfa.isError ? (
        <ErrorState
          title="We couldn't load your team's two-step setting."
          action={
            <Button variant="secondary" onClick={() => void teamMfa.refetch()}>
              Try again
            </Button>
          }
        />
      ) : teamMfa.data ? (
        <RequireCard team={teamMfa.data} onToast={setToast} />
      ) : (
        <div
          className="card two-step-card"
          aria-busy="true"
          aria-label="Loading two-step verification"
        >
          <div className="skeleton-field" />
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

type Asking =
  | { kind: 'role' | 'deactivate' | 'reactivate'; member: TeamMember }
  | { kind: 'revoke'; invitation: TeamInvitation; button: HTMLButtonElement };

const failedChange = (err: unknown) => !(err instanceof ApiError && err.status === 404);

function TeamManager({
  viewer,
  workspace,
  inviting,
  setInviting,
  inviteRef,
  onToast,
}: {
  viewer: Role | null;
  workspace: string;
  inviting: boolean;
  setInviting: (open: boolean) => void;
  inviteRef: RefObject<HTMLButtonElement | null>;
  onToast: (t: string) => void;
}) {
  const team = useTeam();
  const invite = useInvite();
  const resend = useResend();
  const revoke = useRevoke();
  const update = useUpdateMember();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [inviteError, setInviteError] = useState<{ err: unknown; email: string } | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const invitesHeading = useRef<HTMLHeadingElement>(null);
  // Where focus goes when a dialog closes: the row's menu button, or "Invite someone".
  const focusAfter = useRef<() => void>(() => inviteRef.current?.focus());

  const returnFocus = (e: Event) => {
    e.preventDefault();
    focusAfter.current();
  };
  const focusRow = (userId: string) => () =>
    (triggers.current.get(userId) ?? inviteRef.current)?.focus();

  const doResend = (inv: TeamInvitation) =>
    resend.mutate(inv.id, {
      onSuccess: () =>
        onToast(`New invitation sent to ${inv.email}. The old link no longer works.`),
      onError: (err) =>
        onToast(
          err instanceof ApiError && err.code === 'rate_limited'
            ? "You've sent a lot of invitations. Try again in an hour."
            : "That didn't save. Try again.",
        ),
    });

  const patch = (member: TeamMember, body: MemberPatch, done: string) =>
    update.mutate(
      { userId: member.userId, patch: body },
      {
        onSuccess: () => {
          setAsking(null);
          onToast(done);
        },
        onError: (err) => {
          // A member gone in the meantime: refresh rather than retry.
          if (!failedChange(err)) {
            setAsking(null);
            void team.refetch();
          }
        },
      },
    );

  const onAction = (m: TeamMember, a: MemberAction) => {
    update.reset();
    focusAfter.current = focusRow(m.userId);
    if (a === 'grant_rights' || a === 'remove_rights') {
      const grant = a === 'grant_rights';
      update.mutate(
        { userId: m.userId, patch: { approvalRights: grant } },
        {
          onSuccess: () =>
            onToast(
              grant
                ? `${m.email} can now approve quotes and discounts.`
                : `${m.email} can no longer approve.`,
            ),
          onError: () => onToast("That didn't save. Try again."),
        },
      );
      return;
    }
    setAsking({ kind: a === 'change_role' ? 'role' : a, member: m });
  };

  if (team.isError)
    return (
      <ErrorState
        title="We couldn't load your team."
        action={
          <Button variant="secondary" onClick={() => void team.refetch()}>
            Try again
          </Button>
        }
      />
    );
  if (!team.data)
    return (
      <section className="team-section" aria-busy="true" aria-label="Loading your team">
        <div className="skeleton-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      </section>
    );

  const { members, invitations } = team.data;
  const memberAsked = asking && asking.kind !== 'revoke' ? asking.member : null;
  const changeFailed = update.isError && failedChange(update.error);

  return (
    <>
      <MembersSection
        members={members}
        actionsOf={(m) => memberActions(viewer, m)}
        onAction={onAction}
        triggerRef={(id) => (el) => {
          if (el) triggers.current.set(id, el);
          else triggers.current.delete(id);
        }}
        busyId={update.isPending ? (update.variables?.userId ?? null) : null}
      />
      {invitations.length > 0 ? (
        <InvitationsSection
          invitations={invitations}
          resendingId={resend.isPending ? (resend.variables ?? null) : null}
          onResend={doResend}
          onRevoke={(invitation, button) => {
            revoke.reset();
            focusAfter.current = () => button.focus();
            setAsking({ kind: 'revoke', invitation, button });
          }}
          headingRef={invitesHeading}
        />
      ) : (
        members.length === 1 && (
          <EmptyState
            title="Just you so far"
            action={<Button onClick={() => setInviting(true)}>Invite someone</Button>}
          >
            Invite your staff so they can take over chats and work the inbox.
          </EmptyState>
        )
      )}

      <InviteDialog
        open={inviting}
        onOpenChange={(open) => {
          if (open) return;
          setInviting(false);
          setInviteError(null);
          invite.reset();
        }}
        busy={invite.isPending}
        error={inviteError}
        onCloseAutoFocus={returnFocus}
        onSubmit={(email, role) => {
          focusAfter.current = () => inviteRef.current?.focus();
          setInviteError(null);
          invite.mutate(
            { email, role },
            {
              onSuccess: () => {
                setInviting(false);
                onToast(`Invitation sent to ${email}.`);
              },
              onError: (err) => {
                setInviteError({ err, email });
                document.getElementById('invite-email')?.focus();
              },
            },
          );
        }}
        onErrorLink={(link, email) => {
          setInviting(false);
          setInviteError(null);
          if (link === 'reactivate') {
            const m = members.find((x) => x.email === email);
            if (m) {
              focusAfter.current = focusRow(m.userId);
              setAsking({ kind: 'reactivate', member: m });
            }
          } else {
            const inv = invitations.find((x) => x.email === email);
            if (inv) doResend(inv);
          }
        }}
      />

      <RoleDialog
        key={memberAsked?.userId ?? 'none'}
        member={asking?.kind === 'role' ? asking.member : null}
        workspace={workspace}
        busy={update.isPending}
        failed={changeFailed}
        onOpenChange={(open) => !open && setAsking(null)}
        onCloseAutoFocus={returnFocus}
        onSubmit={(role) =>
          memberAsked &&
          patch(memberAsked, { role }, `${memberAsked.email} is now ${withArticle(role)}.`)
        }
      />

      <ConfirmDialog
        open={asking?.kind === 'deactivate'}
        onOpenChange={(open) => !open && setAsking(null)}
        title={`Deactivate ${memberAsked?.email ?? ''}?`}
        confirmLabel="Deactivate"
        confirmVariant="danger"
        busy={update.isPending}
        busyLabel="Deactivating…"
        onCloseAutoFocus={returnFocus}
        onConfirm={() =>
          memberAsked &&
          patch(memberAsked, { status: 'deactivated' }, `${memberAsked.email} is deactivated.`)
        }
        alert={changeFailed && <ChangeFailed />}
      >
        They'll be signed out of {workspace} straight away and can't come back until someone
        reactivates them. Their past replies and notes stay.
      </ConfirmDialog>

      <ConfirmDialog
        open={asking?.kind === 'reactivate'}
        onOpenChange={(open) => !open && setAsking(null)}
        title={`Reactivate ${memberAsked?.email ?? ''}?`}
        confirmLabel="Reactivate"
        busy={update.isPending}
        busyLabel="Reactivating…"
        onCloseAutoFocus={returnFocus}
        onConfirm={() =>
          memberAsked &&
          patch(memberAsked, { status: 'active' }, `${memberAsked.email} can sign in again.`)
        }
        alert={changeFailed && <ChangeFailed />}
      >
        They'll get back in as {memberAsked ? roleLabel(memberAsked.role) : ''}.
      </ConfirmDialog>

      <ConfirmDialog
        open={asking?.kind === 'revoke'}
        onOpenChange={(open) => !open && setAsking(null)}
        title={`Revoke the invitation to ${asking?.kind === 'revoke' ? asking.invitation.email : ''}?`}
        confirmLabel="Revoke"
        confirmVariant="danger"
        busy={revoke.isPending}
        busyLabel="Revoking…"
        onCloseAutoFocus={returnFocus}
        onConfirm={() => {
          if (asking?.kind !== 'revoke') return;
          revoke.mutate(asking.invitation.id, {
            onSuccess: () => {
              // The row is gone: focus its section's heading, or "Invite someone" with it.
              focusAfter.current = () => (invitesHeading.current ?? inviteRef.current)?.focus();
              setAsking(null);
              onToast('Invitation revoked.');
            },
          });
        }}
        alert={revoke.isError && <ChangeFailed />}
      >
        The link stops working.
      </ConfirmDialog>
    </>
  );
}

const ChangeFailed = () => (
  <div className="alert alert--danger" role="alert">
    <p>That didn't save. Try again.</p>
  </div>
);

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
