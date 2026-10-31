import { schema } from '@kaki/db';
import { describe, expect, it } from 'vitest';
import { conversationOpen, statusOpen } from './gate.js';
import { TaskKind } from './plan.js';

describe('the send gate by conversation state (ADR-013 d3; FEAT-042 D2)', () => {
  it('answers AI, escalated and waiting-for-approval conversations; never human or closed', () => {
    expect(statusOpen('ai')).toBe(true);
    expect(statusOpen('escalated')).toBe(true);
    expect(statusOpen('waiting_approval')).toBe(true);
    expect(statusOpen('human')).toBe(false);
    expect(statusOpen('closed')).toBe(false);
  });
});

describe('the send gate and the human owner (ADR-013 d3; FEAT-043 §5.2)', () => {
  it('an owner closes the gate even when the status is still ai', () => {
    expect(conversationOpen('ai', false)).toBe(true);
    expect(conversationOpen('ai', true)).toBe(false);
    expect(conversationOpen('escalated', true)).toBe(false);
    expect(conversationOpen('human', false)).toBe(false);
  });
});

describe('stored task kinds (FEAT-042 D4)', () => {
  it("messages_task_kinds_ck's list equals triage's task kinds", () => {
    expect([...schema.MESSAGE_TASK_KINDS]).toEqual(TaskKind.options);
  });
});
