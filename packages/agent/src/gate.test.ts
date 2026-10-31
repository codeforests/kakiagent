import { schema } from '@kaki/db';
import { describe, expect, it } from 'vitest';
import { statusOpen } from './gate.js';
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

describe('stored task kinds (FEAT-042 D4)', () => {
  it("messages_task_kinds_ck's list equals triage's task kinds", () => {
    expect([...schema.MESSAGE_TASK_KINDS]).toEqual(TaskKind.options);
  });
});
