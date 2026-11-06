import { describe, expect, it } from 'vitest';
import { alertLink, linkFor, settingsLink } from './links.js';
import { muteEvent } from './kinds.js';
import { APPROVAL_LINK_NOTE, alertEmail, digestEmail, type AlertItem } from './templates.js';

const ctx = {
  to: 'owner@kaki-bakery.test',
  businessName: 'Kaki <Bakery> & Co',
  settingsLink: settingsLink('https://app.test/'),
};
const at = new Date('2026-11-01T14:05:00Z'); // 22:05 SGT
const item = (over: Partial<AlertItem> = {}): AlertItem => ({
  kind: 'escalation',
  urgent: false,
  at,
  link: 'https://app.test/inbox/c1',
  ...over,
});

describe('alert emails', () => {
  it('subjects name the business and the event', () => {
    expect(alertEmail(item(), ctx).subject).toBe(
      '[Kaki <Bakery> & Co] A customer wants to talk to a person',
    );
    expect(alertEmail(item({ kind: 'approval_pending' }), ctx).subject).toBe(
      '[Kaki <Bakery> & Co] A reply is waiting for your approval',
    );
    expect(alertEmail(item({ kind: 'hot_lead' }), ctx).subject).toBe(
      '[Kaki <Bakery> & Co] New hot lead',
    );
    expect(alertEmail(item({ kind: 'escalation_reminder' }), ctx).subject).toBe(
      '[Kaki <Bakery> & Co] Reminder: a customer is still waiting for a person',
    );
    expect(alertEmail(item({ kind: 'test' }), ctx).subject).toBe(
      '[Kaki <Bakery> & Co] Test alert from KakiAgent',
    );
  });

  it('urgent alerts start with "Urgent: "', () => {
    expect(alertEmail(item({ urgent: true }), ctx).subject).toMatch(/^Urgent: \[Kaki/);
  });

  it('HTML is escaped; the text carries the link and the settings footer', () => {
    const e = alertEmail(item(), ctx);
    expect(e.to).toBe(ctx.to);
    expect(e.html).toContain('Kaki &lt;Bakery&gt; &amp; Co');
    expect(e.html).not.toContain('<Bakery>');
    expect(e.text).toContain('Open in KakiAgent: https://app.test/inbox/c1');
    expect(e.text).toContain('https://app.test/account/notifications');
  });

  it('carries nothing but the event, business, time and links (D12)', () => {
    const e = alertEmail(item(), ctx);
    const urls = e.text.match(/https?:\/\/\S+/g);
    expect(urls).toEqual(['https://app.test/inbox/c1', 'https://app.test/account/notifications']);
    expect(e.text.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('a digest lists alerts oldest first with their Singapore times', () => {
    const later = item({ kind: 'hot_lead', at: new Date('2026-11-01T15:30:00Z'), link: 'L2' });
    const d = digestEmail([later, item()], ctx);
    expect(d.subject).toBe('[Kaki <Bakery> & Co] 2 alerts while your quiet hours were on');
    const lines = d.text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      '- 10:05 pm: A customer asked to talk to a person. https://app.test/inbox/c1',
      '- 11:30 pm: A new hot lead came in. L2',
    ]);
    expect(digestEmail([item()], ctx).subject).toContain('1 alert while');
  });
});

describe('mute mapping (FEAT-044 D6)', () => {
  it('a reminder is muted with escalations; the test alert never', () => {
    expect(muteEvent('escalation_reminder')).toBe('escalation');
    expect(muteEvent('escalation')).toBe('escalation');
    expect(muteEvent('hot_lead')).toBe('hot_lead');
    expect(muteEvent('test')).toBeNull();
  });
});

describe('links', () => {
  it('each kind opens its dashboard page', () => {
    const s = { type: 'conversation' as const, id: 'x1' };
    expect(linkFor('escalation', s, 'https://app.test')).toBe('https://app.test/inbox/x1');
    expect(linkFor('escalation_reminder', s, 'https://app.test')).toBe('https://app.test/inbox/x1');
    expect(linkFor('approval_pending', s, 'https://app.test')).toBe(
      'https://app.test/approvals/x1',
    );
    expect(linkFor('hot_lead', s, 'https://app.test')).toBe('https://app.test/leads/x1');
    expect(linkFor('test', s, 'https://app.test')).toBe('https://app.test/account/notifications');
  });

  it('an injected linkOf goes first; null falls back to the dashboard page (FEAT-056)', () => {
    const it0 = {
      tenantId: 't1',
      userId: 'u1',
      kind: 'approval_pending' as const,
      subject: { type: 'approval' as const, id: 'a1' },
    };
    expect(alertLink(() => 'https://app.test/approve#token=x', it0, 'https://app.test')).toBe(
      'https://app.test/approve#token=x',
    );
    expect(alertLink(() => null, it0, 'https://app.test')).toBe('https://app.test/approvals/a1');
    expect(alertLink(undefined, it0, 'https://app.test')).toBe('https://app.test/approvals/a1');
  });
});

describe('approval link copy (FEAT-056 §5.2)', () => {
  const approval = item({ kind: 'approval_pending', link: 'https://app.test/approve#token=t' });

  it('approval_pending says "Review and approve" and that the link works once, for 24 hours', () => {
    const e = alertEmail(approval, ctx);
    expect(e.text).toContain('Review and approve: https://app.test/approve#token=t');
    expect(e.text).toContain(APPROVAL_LINK_NOTE);
    expect(e.html).toContain('<strong>Review and approve</strong>');
    expect(e.html).toContain('This link works once, for 24 hours. You&#39;ll be asked to sign in.');
    const other = alertEmail(item(), ctx);
    expect(other.text).toContain('Open in KakiAgent:');
    expect(other.text).not.toContain(APPROVAL_LINK_NOTE);
    const undeliverable = alertEmail(item({ kind: 'approval_undeliverable' }), ctx);
    expect(undeliverable.html).toContain('Open in KakiAgent');
    expect(undeliverable.text).not.toContain(APPROVAL_LINK_NOTE);
  });

  it('a digest says it once, under the list, only when an item is an approval', () => {
    const d = digestEmail(
      [approval, item(), { ...approval, link: 'https://app.test/approve#token=u' }],
      ctx,
    );
    expect(d.text.split(APPROVAL_LINK_NOTE)).toHaveLength(2);
    expect(d.text.indexOf(APPROVAL_LINK_NOTE)).toBeGreaterThan(d.text.lastIndexOf('- '));
    expect(d.html.split('This link works once')).toHaveLength(2);
    expect(digestEmail([item()], ctx).text).not.toContain(APPROVAL_LINK_NOTE);
  });
});
