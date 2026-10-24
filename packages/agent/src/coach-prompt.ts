import { TRIAGE_SYSTEM } from './plan.js';

const LAST = 'Every message has at least one task.';

/**
 * Coaching triage (FEAT-027 §5.2, ADR-026): the visitor triage lines plus the
 * coaching-only `correct` task. Fixed text with no tenant data, so its cached prefix is
 * shared by every tenant; the visitor prompt never lists `correct`.
 */
export const COACH_TRIAGE_SYSTEM = TRIAGE_SYSTEM.replace(
  `\n${LAST}`,
  [
    '',
    '  correct: the owner says a price, product detail, FAQ answer, policy, promotion or opening hours is wrong or has changed, or asks you to add an answer.',
    'The latest message is from the business owner testing their assistant, not a visitor.',
    LAST,
  ].join('\n'),
);
