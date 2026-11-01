import { describe, expect, it } from 'vitest';
import {
  ConversationSummary,
  EscalateResponse,
  EscalationRouting,
  EscalationRoutingBody,
  Message,
  ThreadEvent,
  WidgetConfigResponse,
} from './index.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AT = '2026-11-01T09:00:00.000Z';
const escalation = {
  id: ID,
  assignee: { userId: ID, name: 'Mei Ling' },
  since: AT,
  source: 'visitor_button',
  urgent: true,
  afterHours: false,
  reminders: 0,
} as const;
const notice = {
  id: ID,
  conversationId: ID,
  seq: 3,
  author: 'system',
  body: "I've asked the team to join.",
  inReplyTo: null,
  disclosure: null,
  notice: "I've asked the team to join.",
  noticeKind: 'escalated',
  authorName: null,
  language: 'en',
  createdAt: AT,
} as const;

describe('escalation contracts (FEAT-044 §3)', () => {
  it('round-trips a summary with an open escalation and the escalated notice', () => {
    const summary = {
      id: ID,
      channel: 'widget',
      status: 'escalated',
      lastMessageAt: AT,
      lastMessage: 'Can I talk to someone?',
      flaggedAt: null,
      flagReasons: [],
      closeReason: null,
      closedAt: null,
      owner: null,
      escalation,
    } as const;
    expect(ConversationSummary.parse(summary)).toEqual(summary);
    expect(ConversationSummary.safeParse({ ...summary, escalation: undefined }).success).toBe(
      false,
    );
    expect(Message.parse(notice).noticeKind).toBe('escalated');
    expect(EscalateResponse.parse({ status: 'escalated', notice })).toEqual({
      status: 'escalated',
      notice,
    });
    expect(EscalateResponse.parse({ status: 'with_person', notice: null }).notice).toBeNull();
    expect(EscalateResponse.safeParse({ status: 'queued', notice: null }).success).toBe(false);
  });

  it('a divider carries the escalation source', () => {
    const event = {
      at: AT,
      kind: 'state',
      to: 'escalated',
      from: 'ai',
      reason: 'escalated',
      actor: { type: 'visitor', name: null },
      subject: { name: 'Mei Ling' },
      source: 'visitor_asked',
    } as const;
    expect(ThreadEvent.parse(event)).toEqual(event);
    expect(ThreadEvent.safeParse({ ...event, source: 'operator' }).success).toBe(false);
  });

  it('routing: person mode needs a person; extra keys and out-of-range minutes refused', () => {
    expect(
      EscalationRoutingBody.parse({ mode: 'round_robin', personUserId: null, reminderMinutes: 10 }),
    ).toEqual({ mode: 'round_robin', personUserId: null, reminderMinutes: 10 });
    expect(
      EscalationRoutingBody.parse({ mode: 'person', personUserId: ID, reminderMinutes: 240 }).mode,
    ).toBe('person');
    const noPerson = EscalationRoutingBody.safeParse({
      mode: 'person',
      personUserId: null,
      reminderMinutes: 10,
    });
    expect(noPerson.success).toBe(false);
    expect(noPerson.error?.issues[0]?.message).toBe('person_required');
    expect(
      EscalationRoutingBody.safeParse({
        mode: 'round_robin',
        personUserId: null,
        reminderMinutes: 10,
        tenantId: ID,
      }).success,
    ).toBe(false);
    for (const reminderMinutes of [0, 241, 1.5]) {
      expect(
        EscalationRoutingBody.safeParse({
          mode: 'round_robin',
          personUserId: null,
          reminderMinutes,
        }).success,
      ).toBe(false);
    }
    const routing = { mode: 'person', personUserId: ID, reminderMinutes: 15, personInactive: true };
    expect(EscalationRouting.parse(routing)).toEqual(routing);
  });

  it('the widget config still carries talkToPerson', () => {
    expect(WidgetConfigResponse.shape.controls.parse({ talkToPerson: true })).toEqual({
      talkToPerson: true,
    });
  });
});
