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
  | 'coach.use';

const POLICY: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set([
    'inbox.read',
    'inbox.reply',
    'settings.manage',
    'killswitch.toggle',
    'kb.manage',
    'coach.use',
  ]),
  admin: new Set([
    'inbox.read',
    'inbox.reply',
    'settings.manage',
    'killswitch.toggle',
    'kb.manage',
    'coach.use',
  ]),
  agent: new Set(['inbox.read', 'inbox.reply']),
};

export function can(role: Role, capability: Capability): boolean {
  return POLICY[role].has(capability);
}
