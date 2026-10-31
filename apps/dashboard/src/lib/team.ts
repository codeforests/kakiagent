import type { MemberPatch, Role, TeamInvitation, TeamMember, TeamResponse } from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';

/** Team, invitations, roles and approval rights: SCR-APP-045 (FEAT-007 §5.4, ui-design). */

export const TEAM_KEY = ['team'];

export const roleLabel = (role: Role) =>
  role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Agent';

/** The name a member shows as: their display name when set, else their email (FEAT-008). */
export const memberName = (m: Pick<TeamMember, 'displayName' | 'email'>) =>
  m.displayName ?? m.email;

/** An avatar's letter: the first character, whole even when it is CJK or an emoji. */
export const initialOf = (s: string) => (Array.from(s)[0] ?? ' ').toUpperCase();

/** "an Admin", "an Agent", "an Owner": every role starts with a vowel. */
export const withArticle = (role: Role) => `an ${roleLabel(role)}`;

/** The two roles an invite or a role change can give, with their descriptions. */
export const ROLE_CHOICES = [
  { role: 'admin', description: 'Manages the knowledge base, channels, rules and the team.' },
  { role: 'agent', description: 'Works the inbox and leads.' },
] as const;

export type MemberAction =
  'change_role' | 'grant_rights' | 'remove_rights' | 'deactivate' | 'reactivate';

/**
 * What the viewer may do to a member's row (design D3, §3): Owners and Admins manage
 * Admins and Agents; the Owner's row and your own have nothing; only the Owner grants
 * approval rights, and only on an active Agent.
 */
export function memberActions(viewer: Role | null | undefined, member: TeamMember): MemberAction[] {
  if (viewer !== 'owner' && viewer !== 'admin') return [];
  if (member.role === 'owner' || member.you) return [];
  if (member.status === 'deactivated') return ['reactivate'];
  const actions: MemberAction[] = ['change_role'];
  if (viewer === 'owner' && member.role === 'agent')
    actions.push(member.approvalRights ? 'remove_rights' : 'grant_rights');
  actions.push('deactivate');
  return actions;
}

/** The invite dialog's error, keyed on the API's codes (`apps/api/src/team.ts`). */
export type InviteErrorText = { text: string; link?: 'reactivate' | 'resend' };

export function inviteErrorText(err: unknown, email: string): InviteErrorText {
  const code = err instanceof ApiError ? err.code : null;
  switch (code) {
    case 'already_member':
      return { text: `${email} is already in your team.` };
    case 'member_deactivated':
      return { text: `${email} was deactivated.`, link: 'reactivate' };
    case 'invite_pending':
      return { text: `There's already an invitation for ${email}.`, link: 'resend' };
    case 'rate_limited':
      return { text: "You've sent a lot of invitations. Try again in an hour." };
    default:
      return { text: "That didn't save. Try again." };
  }
}

/** "Today 14:02", "3 Oct", or "Never" (ui-design, Members table). */
export function lastActiveText(iso: string | null, now = new Date()): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString())
    return `Today ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "7 Nov", for an invitation's expiry. */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function useTeam(enabled = true) {
  return useQuery({
    queryKey: TEAM_KEY,
    queryFn: api.team,
    enabled,
    // An Agent's 403 is the read-only state, not an error worth retrying.
    retry: (n, err) => !(err instanceof ApiError && err.status === 403) && n < 2,
  });
}

/** Puts a new or resent invitation at the top, in place of the one it replaces. */
function withInvitation(old: TeamResponse | undefined, inv: TeamInvitation, replaces?: string) {
  if (!old) return old;
  const rest = old.invitations.filter((i) => i.id !== replaces && i.email !== inv.email);
  return { ...old, invitations: [inv, ...rest] };
}

export function useInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.invite,
    onSuccess: (inv) =>
      queryClient.setQueryData<TeamResponse>(TEAM_KEY, (old) => withInvitation(old, inv)),
  });
}

export function useResend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.resendInvite(id),
    onSuccess: (inv, id) =>
      queryClient.setQueryData<TeamResponse>(TEAM_KEY, (old) => withInvitation(old, inv, id)),
  });
}

export function useRevoke() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: (_, id) =>
      queryClient.setQueryData<TeamResponse>(TEAM_KEY, (old) =>
        old ? { ...old, invitations: old.invitations.filter((i) => i.id !== id) } : old,
      ),
  });
}

export function useUpdateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: MemberPatch }) =>
      api.updateMember(userId, patch),
    // The whole team comes back (D8), so a stale screen corrects itself.
    onSuccess: (team) => queryClient.setQueryData(TEAM_KEY, team),
  });
}
