import type { InvitableRole, TeamInvitation, TeamMember } from '@kaki/contracts';
import { Button, FormDialog } from '@kaki/ui';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useState, type Ref } from 'react';
import {
  inviteErrorText,
  lastActiveText,
  ROLE_CHOICES,
  roleLabel,
  shortDate,
  type InviteErrorText,
  type MemberAction,
} from '../lib/team.ts';

/** SCR-APP-045's parts (FEAT-007 ui-design): members, invitations and the two form dialogs. */

const BadgeCheck = () => (
  <svg
    className="team-rights__icon"
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

function RoleCell({ member }: { member: TeamMember }) {
  return (
    <>
      {roleLabel(member.role)}
      {member.status === 'deactivated' && (
        <span className="status-badge status-badge--neutral team-table__badge">Deactivated</span>
      )}
      {member.approvalRights && member.status === 'active' && (
        <span className="team-rights">
          <BadgeCheck />
          Can approve
        </span>
      )}
    </>
  );
}

const MENU_TEXT: Record<MemberAction, string> = {
  change_role: 'Change role',
  grant_rights: 'Give approval rights',
  remove_rights: 'Remove approval rights',
  deactivate: 'Deactivate',
  reactivate: 'Reactivate',
};

function RowMenu({
  member,
  actions,
  onAction,
  triggerRef,
  busy,
}: {
  member: TeamMember;
  actions: MemberAction[];
  onAction: (a: MemberAction) => void;
  triggerRef: Ref<HTMLButtonElement>;
  busy: boolean;
}) {
  const main = actions.filter((a) => a !== 'deactivate');
  return (
    // Non-modal, as the other row menus: a modal menu aria-hides the page.
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        ref={triggerRef}
        className="icon-button"
        aria-label={`Actions for ${member.email}`}
        aria-busy={busy || undefined}
      >
        <span aria-hidden="true">⋯</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
          {main.map((a) => (
            <DropdownMenu.Item key={a} className="menu__item" onSelect={() => onAction(a)}>
              {a === 'remove_rights' && (
                <span className="team-menu__check" aria-hidden="true">
                  ✓
                </span>
              )}
              {MENU_TEXT[a]}
            </DropdownMenu.Item>
          ))}
          {actions.includes('deactivate') && (
            <>
              <DropdownMenu.Separator className="menu__divider" />
              <DropdownMenu.Item
                className="menu__item menu__item--danger"
                onSelect={() => onAction('deactivate')}
              >
                Deactivate
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Members: a table, stacked below 768 px (the meta line shows only there). */
export function MembersSection({
  members,
  actionsOf,
  onAction,
  triggerRef,
  busyId,
}: {
  members: TeamMember[];
  actionsOf: (m: TeamMember) => MemberAction[];
  onAction: (m: TeamMember, a: MemberAction) => void;
  triggerRef: (userId: string) => Ref<HTMLButtonElement>;
  busyId: string | null;
}) {
  return (
    <section className="team-section" aria-labelledby="team-members-title">
      <h2 className="section-title" id="team-members-title">
        Members <span className="team-section__count">· {members.length}</span>
      </h2>
      <table className="team-table">
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Role</th>
            <th scope="col">Two-step</th>
            <th scope="col">Last active</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const actions = actionsOf(m);
            const off = m.status === 'deactivated';
            return (
              <tr
                key={m.userId}
                className={off ? 'team-row team-row--off' : 'team-row'}
                data-testid="team-member"
              >
                <th scope="row" className="team-row__person">
                  <span className="avatar" aria-hidden="true">
                    {m.email[0]!.toUpperCase()}
                  </span>
                  <span className="team-row__who">
                    <span className="team-row__email">
                      {m.email}
                      {m.you && <span className="chip chip--neutral">You</span>}
                    </span>
                    <span className="team-row__meta">
                      {roleLabel(m.role)}
                      {off ? ' · Deactivated' : m.approvalRights ? ' · Can approve' : ''}
                      {` · Two-step ${m.mfaEnrolled ? 'on' : 'off'} · Last active ${lastActiveText(m.lastActiveAt)}`}
                    </span>
                  </span>
                </th>
                <td className="team-row__wide">
                  <RoleCell member={m} />
                </td>
                <td className="team-row__wide">
                  <span
                    className={`status-badge ${m.mfaEnrolled ? 'status-badge--success' : 'status-badge--neutral'}`}
                  >
                    {m.mfaEnrolled ? 'On' : 'Off'}
                  </span>
                </td>
                <td className="team-row__wide">{lastActiveText(m.lastActiveAt)}</td>
                <td className="team-row__actions">
                  {actions.length > 0 && (
                    <RowMenu
                      member={m}
                      actions={actions}
                      onAction={(a) => onAction(m, a)}
                      triggerRef={triggerRef(m.userId)}
                      busy={busyId === m.userId}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function InvitationsSection({
  invitations,
  onResend,
  onRevoke,
  resendingId,
  headingRef,
}: {
  invitations: TeamInvitation[];
  onResend: (inv: TeamInvitation) => void;
  onRevoke: (inv: TeamInvitation, button: HTMLButtonElement) => void;
  resendingId: string | null;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <section className="team-section" aria-labelledby="team-invites-title">
      <h2 className="section-title" id="team-invites-title" ref={headingRef} tabIndex={-1}>
        Invitations
      </h2>
      <ul className="team-invites">
        {invitations.map((inv) => (
          <li key={inv.id} className="team-invite" data-testid="team-invitation">
            <div className="team-invite__main">
              <span className="team-invite__email">{inv.email}</span>
              <span className="team-invite__meta">
                {roleLabel(inv.role)} · Invited by {inv.invitedBy}
                {inv.state === 'pending' && ` · expires ${shortDate(inv.expiresAt)}`}
              </span>
              <span className="team-invite__badges">
                {inv.state === 'expired' && (
                  <span className="status-badge status-badge--warning">Expired</span>
                )}
                {inv.delivery === 'queued' && inv.state === 'pending' && (
                  <>
                    <span className="status-badge status-badge--neutral">Sending…</span>
                    <span className="field__help">We'll keep trying to send it.</span>
                  </>
                )}
              </span>
            </div>
            <div className="team-invite__actions">
              <Button
                variant="secondary"
                className="kaki-btn--sm"
                onClick={() => onResend(inv)}
                disabled={resendingId === inv.id}
                aria-label={`Resend the invitation to ${inv.email}`}
              >
                {resendingId === inv.id ? 'Sending…' : 'Resend'}
              </Button>
              <Button
                variant="ghost"
                className="kaki-btn--sm"
                onClick={(e) => onRevoke(inv, e.currentTarget)}
                aria-label={`Revoke the invitation to ${inv.email}`}
              >
                Revoke
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RoleRadios({
  name,
  value,
  onChange,
}: {
  name: string;
  value: InvitableRole | null;
  onChange: (r: InvitableRole) => void;
}) {
  return (
    <fieldset className="radio-group team-roles">
      <legend className="field__label">Role</legend>
      {ROLE_CHOICES.map((c) => (
        <label className="radio team-roles__choice" key={c.role}>
          <input
            type="radio"
            name={name}
            checked={value === c.role}
            onChange={() => onChange(c.role)}
            aria-describedby={`${name}-${c.role}-help`}
          />
          <span>
            <span className="team-roles__name">{roleLabel(c.role)}</span>
            <span className="field__help" id={`${name}-${c.role}-help`}>
              {c.description}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteDialog({
  open,
  onOpenChange,
  busy,
  error,
  onSubmit,
  onErrorLink,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  /** The last failed send, with the address it was for. */
  error: { err: unknown; email: string } | null;
  onSubmit: (email: string, role: InvitableRole) => void;
  onErrorLink: (link: NonNullable<InviteErrorText['link']>, email: string) => void;
  onCloseAutoFocus: (e: Event) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole>('agent');
  const [invalid, setInvalid] = useState(false);
  const serverInvalid = error && (error.err as { status?: number }).status === 400 ? true : false;
  const shown = error && !serverInvalid ? inviteErrorText(error.err, error.email) : null;
  const fieldError =
    invalid || serverInvalid ? 'Enter an email address like name@business.sg' : null;

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setEmail('');
          setRole('agent');
          setInvalid(false);
        }
        onOpenChange(next);
      }}
      title="Invite someone"
      busy={busy}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <form
        className="team-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const address = email.trim().toLowerCase();
          if (!EMAIL.test(address)) {
            setInvalid(true);
            document.getElementById('invite-email')?.focus();
            return;
          }
          setInvalid(false);
          onSubmit(address, role);
        }}
      >
        {shown && (
          <div className="alert alert--danger" role="alert">
            <p>
              {shown.text}{' '}
              {shown.link && (
                <button
                  type="button"
                  className="team-form__link"
                  onClick={() => onErrorLink(shown.link!, error!.email)}
                >
                  {shown.link === 'reactivate' ? 'Reactivate them' : 'Resend it'}
                </button>
              )}
            </p>
          </div>
        )}
        <div className="field">
          <label className="field__label" htmlFor="invite-email">
            Email address
          </label>
          <input
            id="invite-email"
            className="input"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'invite-email-error' : undefined}
          />
          {fieldError && (
            <p className="field__error" id="invite-email-error">
              {fieldError}
            </p>
          )}
        </div>
        <RoleRadios name="invite-role" value={role} onChange={setRole} />
        <p className="field__help">
          The invitation link works once and for 7 days, only for this email address.
        </p>
        <div className="kaki-dialog__actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Sending…' : 'Send invitation'}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

export function RoleDialog({
  member,
  workspace,
  busy,
  failed,
  onOpenChange,
  onSubmit,
  onCloseAutoFocus,
}: {
  member: TeamMember | null;
  workspace: string;
  busy: boolean;
  failed: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (role: InvitableRole) => void;
  onCloseAutoFocus: (e: Event) => void;
}) {
  const [picked, setPicked] = useState<InvitableRole | null>(null);
  const current = member?.role === 'owner' ? null : (member?.role ?? null);
  const value = picked ?? current;
  const changed = value !== null && value !== current;
  return (
    <FormDialog
      open={member !== null}
      onOpenChange={(next) => {
        if (!next) setPicked(null);
        onOpenChange(next);
      }}
      title={member ? `Change ${member.email}'s role` : 'Change role'}
      busy={busy}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <form
        className="team-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) onSubmit(value);
        }}
      >
        {failed && (
          <div className="alert alert--danger" role="alert">
            <p>That didn't save. Try again.</p>
          </div>
        )}
        <RoleRadios name="member-role" value={value} onChange={setPicked} />
        <p className="field__help">
          They'll be signed out of {workspace} and sign back in with the new role.
          {changed && value === 'admin' && member?.approvalRights
            ? ' Approval rights come with the Admin role.'
            : ''}
          {changed && value === 'agent'
            ? " They won't be able to approve until the Owner grants it again."
            : ''}
        </p>
        <div className="kaki-dialog__actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !changed} aria-busy={busy || undefined}>
            {busy ? 'Saving…' : 'Change role'}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}
