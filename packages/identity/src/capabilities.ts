/**
 * Central (role, capability) policy (ADR-020, SRS §2.1). The skeleton holds the
 * capabilities its two screens need; FEAT-005 and FEAT-007 complete the table and add
 * per-user grants (D3 approval rights).
 */
export type Role = 'owner' | 'admin' | 'agent';
export type Capability =
  | 'inbox.read'
  | 'inbox.reply'
  | 'settings.manage'
  | 'killswitch.toggle'
  /** Create and edit facts by hand (KB-07; FEAT-022). */
  | 'kb.manage'
  /** Chat with the assistant in the dashboard and teach it corrections (AGT-17; FEAT-027). */
  | 'coach.use'
  /** Require two-step verification of every member (AUTH-03; FEAT-006 D8). Owner only. */
  | 'security.manage'
  /** Invite, change roles of and deactivate members (DSH-03; FEAT-007 D3). */
  | 'team.manage'
  /** Grant or remove an Agent's approval rights (D3; FEAT-007). Owner only. */
  | 'team.grant_approval'
  /** Decide approvals by role (APR-02); Agents only through a grant, see `canApprove`. */
  | 'approvals.decide';

const POLICY: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set([
    'inbox.read',
    'inbox.reply',
    'settings.manage',
    'killswitch.toggle',
    'kb.manage',
    'coach.use',
    'security.manage',
    'team.manage',
    'team.grant_approval',
    'approvals.decide',
  ]),
  admin: new Set([
    'inbox.read',
    'inbox.reply',
    'settings.manage',
    'killswitch.toggle',
    'kb.manage',
    'coach.use',
    'team.manage',
    'approvals.decide',
  ]),
  agent: new Set(['inbox.read', 'inbox.reply']),
};

export function can(role: Role, capability: Capability): boolean {
  return POLICY[role].has(capability);
}

/** May this member decide approvals (D3, APR-02)? Owner and Admin by role, an Agent by grant. */
export function canApprove(m: { role: Role; approvalRights: boolean }): boolean {
  return can(m.role, 'approvals.decide') || (m.role === 'agent' && m.approvalRights);
}
