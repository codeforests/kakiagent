import { z } from 'zod';

// ---- Shared shapes ---------------------------------------------------------------

export const MessageAuthor = z.enum(['visitor', 'agent', 'staff', 'system']);

export const Message = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  seq: z.number().int(),
  author: MessageAuthor,
  body: z.string(),
  /** The visitor message an agent or system reply answers (groups SSE segments). */
  inReplyTo: z.uuid().nullable(),
  /** The AI disclosure carried by the first agent or system message (AGT-11). */
  disclosure: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Message = z.infer<typeof Message>;

export const ConversationSummary = z.object({
  id: z.uuid(),
  channel: z.enum(['widget']),
  status: z.enum(['ai', 'human', 'closed']),
  lastMessageAt: z.iso.datetime({ offset: true }),
  lastMessage: z.string().nullable(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ErrorBody = z.object({ error: z.string(), message: z.string() });

// ---- Widget API (api role; ADR-016 decision 6) -----------------------------------

export const WidgetConfigQuery = z.object({ key: z.string().min(1).max(100) });
export const WidgetConfigResponse = z.object({
  token: z.string(),
  visitorId: z.uuid(),
  /** Base URL of the realtime role, for the SSE stream. */
  realtimeUrl: z.url(),
  /** Lazy panel chunk to load on first open. */
  panelUrl: z.url(),
  botName: z.string(),
});
export type WidgetConfigResponse = z.infer<typeof WidgetConfigResponse>;

export const CreateConversationResponse = z.object({ conversationId: z.uuid() });

export const SendMessageBody = z.object({
  text: z.string().trim().min(1).max(4000),
  clientMessageId: z.string().min(8).max(64),
});
export const SendMessageResponse = z.object({ message: Message });

// ---- Dashboard API (api role) ----------------------------------------------------

export const Me = z.object({
  userId: z.string(),
  role: z.enum(['owner', 'admin', 'agent']),
  tenant: z.object({ id: z.uuid(), name: z.string(), status: z.enum(['active', 'suspended']) }),
});
export type Me = z.infer<typeof Me>;

export const ConversationList = z.object({ conversations: z.array(ConversationSummary) });

// ---- Dashboard API: facts (KB-07; FEAT-022 design §3.2) ------------------------------

export const FactStatus = z.enum([
  'needs_review',
  'approved',
  'rejected',
  'conflicted',
  'disabled',
]);
export type FactStatus = z.infer<typeof FactStatus>;
export const GstTreatment = z.enum(['inclusive', 'exclusive', 'unknown']);

/** SGD as typed: dollars with up to two decimals, like 55 or 55.00. */
export const Money = z
  .string()
  .trim()
  .regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter the price in dollars and cents, like 55.00');

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).optional(),
  );

export const ProductValueInput = z.object({
  name: z.string().trim().min(1).max(200),
  price: Money,
  unit: optionalText(60),
});
export const FaqValueInput = z.object({
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(2000),
});
/** Manual entries: the owner always chooses the GST treatment of a price (KB-15). */
export const ManualGstTreatment = z.enum(['inclusive', 'exclusive']);

export const CreateFactBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('product'),
    value: ProductValueInput,
    gstTreatment: ManualGstTreatment,
  }),
  z.object({
    type: z.literal('faq'),
    value: FaqValueInput,
    gstTreatment: z.null().optional(),
  }),
]);
export type CreateFactBody = z.infer<typeof CreateFactBody>;

/** `value` is checked against the fact's own type by the route. */
export const UpdateFactBody = z
  .object({
    version: z.int().min(1),
    value: z.record(z.string(), z.unknown()).optional(),
    gstTreatment: ManualGstTreatment.optional(),
    status: z.enum(['approved', 'disabled']).optional(),
  })
  .refine((b) => b.value !== undefined || b.gstTreatment !== undefined || b.status !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateFactBody = z.infer<typeof UpdateFactBody>;

const factBase = {
  id: z.uuid(),
  status: FactStatus,
  version: z.int(),
  source: z.string(),
  updatedAt: z.iso.datetime({ offset: true }),
};
export const Fact = z.discriminatedUnion('type', [
  z.object({
    ...factBase,
    type: z.literal('product'),
    value: z.object({ name: z.string(), price: Money, unit: z.string().optional() }),
    gstTreatment: GstTreatment,
  }),
  z.object({
    ...factBase,
    type: z.literal('faq'),
    value: z.object({ question: z.string(), answer: z.string() }),
    gstTreatment: z.null(),
  }),
]);
export type Fact = z.infer<typeof Fact>;

export const FactListQuery = z.object({
  status: FactStatus.optional(),
  q: z.string().trim().max(100).optional(),
});
export const FactList = z.object({ facts: z.array(Fact) });
export const FactResponse = z.object({ fact: Fact });

// ---- Realtime events (Valkey pub/sub payloads, SSE and WebSocket frames; ADR-017) --

export const MessageEvent = z.object({ type: z.literal('message'), message: Message });
export const ConversationEvent = z.object({
  type: z.literal('conversation'),
  conversation: ConversationSummary,
});
/**
 * One verified sentence of a reply in progress (ADR-008), SSE only and never stored:
 * the stored `message` replaces the turn's segments. No fact IDs go to visitors (D9).
 */
export const SegmentEvent = z.object({
  type: z.literal('segment'),
  /** The visitor message being answered. */
  turnId: z.uuid(),
  seq: z.int().min(0),
  text: z.string(),
});
export type SegmentEvent = z.infer<typeof SegmentEvent>;
export const RealtimeEvent = z.discriminatedUnion('type', [
  MessageEvent,
  ConversationEvent,
  SegmentEvent,
]);
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

// ---- Queue payloads (outbox → SQS; ADR-012) --------------------------------------

export const TurnJob = z.object({
  tenantId: z.uuid(),
  conversationId: z.uuid(),
  messageId: z.uuid(),
});
export type TurnJob = z.infer<typeof TurnJob>;
