import { z } from 'zod';
import { createRegistry, outOfScopeHandler, type Registry, type TaskHandler } from './dispatch.js';

const Interval = z.object({
  open: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  close: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
});
const Day = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const DayHours = z.partialRecord(Day, z.array(Interval).max(4));

/** `propose_correction`'s arguments: `@kaki/kb`'s `ProposalInput`, checked again there. */
export const ProposeCorrectionArgs = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('edit_fact'),
    factId: z.uuid(),
    patch: z.object({
      value: z.record(z.string(), z.unknown()).optional(),
      validity: z.object({ validUntil: z.date().nullable().optional() }).optional(),
    }),
  }),
  z.object({
    kind: z.literal('add_faq'),
    question: z.string().trim().min(1).max(300),
    answer: z.string().trim().min(1).max(2000),
  }),
  z.object({
    kind: z.literal('edit_hours'),
    profileVersion: z.int().min(0),
    before: DayHours,
    after: DayHours,
  }),
]);
export type ProposeCorrectionArgs = z.infer<typeof ProposeCorrectionArgs>;

/**
 * AGT-17 (FEAT-027 §5.2, ADR-026): the owner's correction becomes an open item in the
 * corrections queue, never a fact edit. Coaching scope only; the dispatcher refuses it
 * anywhere else, and without a `correct` task in the plan.
 */
export const proposeCorrectionHandler: TaskHandler<ProposeCorrectionArgs> = {
  kind: 'correct',
  tool: 'propose_correction',
  scopes: ['coaching'],
  args: ProposeCorrectionArgs,
  async run(ctx, args) {
    if (!ctx.coaching) throw new Error('propose_correction: no coaching port');
    return { proposal: await ctx.coaching.propose(args) };
  },
};

/** The coaching scope's handlers (ADR-025, ADR-026). Crisis and abuse stay visitor-only. */
export const coachingRegistry: Registry = createRegistry([
  proposeCorrectionHandler,
  outOfScopeHandler,
]);
