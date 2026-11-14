import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_GROUPS, auditGroupOf } from './audit.js';
import { AuditExportBody, AuditQuery } from './index.js';

describe('audit event groups (FEAT-060 D6)', () => {
  it('maps one code per group, ai.* to assistant and an unknown prefix to other', () => {
    const samples: Record<string, string> = {
      conversations: 'conversation.closed',
      assistant: 'agent.decision',
      knowledge: 'kb_source.added',
      approvals: 'rules.updated',
      contacts: 'consent.withdrawn',
      team: 'member.invited',
      settings: 'widget.updated',
      audit: 'audit.verified',
    };
    for (const g of AUDIT_EVENT_GROUPS) expect(auditGroupOf(samples[g.key]!)).toBe(g.key);
    expect(auditGroupOf('ai.paused')).toBe('assistant');
    expect(auditGroupOf('kb.fact_created')).toBe('knowledge');
    expect(auditGroupOf('mystery.thing')).toBe('other');
    expect(auditGroupOf('conversationx')).toBe('other');
  });
});

describe('AuditQuery (FEAT-060 §3)', () => {
  it('defaults limit to 50 and coerces query strings', () => {
    expect(AuditQuery.parse({})).toEqual({ limit: 50 });
    expect(AuditQuery.parse({ before: '120', limit: '10' })).toEqual({ before: 120, limit: 10 });
  });
  it('refuses limit 101, a bad date, unknown keys, to before from, and a member with a non-user type', () => {
    expect(AuditQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(AuditQuery.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(AuditQuery.safeParse({ from: '14/11/2026' }).success).toBe(false);
    expect(AuditQuery.safeParse({ nope: '1' }).success).toBe(false);
    expect(AuditQuery.safeParse({ from: '2026-11-14', to: '2026-11-13' }).success).toBe(false);
    expect(AuditQuery.safeParse({ from: '2026-11-14', to: '2026-11-14' }).success).toBe(true);
    const actor = '8d0f6a3e-4b7a-4c1e-9f0a-2b3c4d5e6f70';
    expect(AuditQuery.safeParse({ actor, actorType: 'agent' }).success).toBe(false);
    expect(AuditQuery.safeParse({ actor, actorType: 'user' }).success).toBe(true);
    expect(AuditQuery.safeParse({ group: 'other' }).success).toBe(true);
    expect(AuditQuery.safeParse({ group: 'bogus' }).success).toBe(false);
  });
});

describe('AuditExportBody', () => {
  it('needs a format and refuses paging keys', () => {
    expect(AuditExportBody.safeParse({}).success).toBe(false);
    expect(AuditExportBody.safeParse({ format: 'csv' }).success).toBe(true);
    expect(AuditExportBody.safeParse({ format: 'xml' }).success).toBe(false);
    expect(AuditExportBody.safeParse({ format: 'json', limit: 5 }).success).toBe(false);
  });
});
