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
  /** A system notice shown with this message, server-rendered (AGT-09 after hours, FEAT-023). */
  notice: z.string().nullable(),
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

export const Role = z.enum(['owner', 'admin', 'agent']);
export type Role = z.infer<typeof Role>;

/** The signed-in user; role and tenant are null until they have a workspace (FEAT-005 D10). */
export const Me = z.object({
  user: z.object({ id: z.uuid(), email: z.string() }),
  role: Role.nullable(),
  tenant: z
    .object({ id: z.uuid(), name: z.string(), status: z.enum(['active', 'suspended']) })
    .nullable(),
});
export type Me = z.infer<typeof Me>;

export const ConversationList = z.object({ conversations: z.array(ConversationSummary) });

// ---- Dashboard API: sign-in and workspaces (FEAT-005 design §3) ---------------------

export const TermsDocument = z.enum(['tos', 'aup', 'dpa']);
export type TermsDocument = z.infer<typeof TermsDocument>;

export const AuthOptions = z.object({
  /** Whether "Continue with Google" is offered (GOOGLE_CLIENT_ID is set). */
  google: z.boolean(),
  /** The documents a new Owner accepts, at their current versions (AUTH-08). */
  terms: z.array(z.object({ document: TermsDocument, title: z.string(), version: z.string() })),
});
export type AuthOptions = z.infer<typeof AuthOptions>;

export const MagicLinkRequest = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
});
/** The same for every well-formed address (AUTH-01); `delayed` when email is slow (UC-01 2c). */
export const MagicLinkResponse = z.object({ delayed: z.boolean() });

export const MagicLinkVerifyBody = z.object({ token: z.string().max(100) });
export const MagicLinkVerifyResponse = z.object({ next: z.enum(['app', 'create-workspace']) });
export type MagicLinkVerifyResponse = z.infer<typeof MagicLinkVerifyResponse>;

export const CreateWorkspaceBody = z.object({
  businessName: z.string().trim().min(1).max(120),
  /** The versions the user was shown and agreed to (AUTH-08). */
  accepted: z.object({
    tos: z.string().min(1).max(40),
    aup: z.string().min(1).max(40),
    dpa: z.string().min(1).max(40),
  }),
});
export type CreateWorkspaceBody = z.infer<typeof CreateWorkspaceBody>;
export const CreateWorkspaceResponse = z.object({
  tenant: z.object({ id: z.uuid(), name: z.string(), status: z.enum(['active', 'suspended']) }),
});

// ---- Dashboard API: facts (KB-07; FEAT-022 §3.2, FEAT-011 §3) -----------------------

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
export const PolicyKind = z.enum(['refund', 'delivery', 'booking', 'payment', 'other']);
export type PolicyKind = z.infer<typeof PolicyKind>;
export const PolicyValueInput = z.object({
  kind: PolicyKind,
  title: z.string().trim().min(1).max(120),
  details: z.string().trim().min(1).max(2000),
});
export const PromotionValueInput = z.object({
  title: z.string().trim().min(1).max(120),
  details: z.string().trim().min(1).max(2000),
  price: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    Money.optional(),
  ),
});
/** Manual entries: the owner always chooses the GST treatment of a price (KB-15). */
export const ManualGstTreatment = z.enum(['inclusive', 'exclusive']);

/** A calendar day in Singapore, `YYYY-MM-DD` (FEAT-011 D3); a real day, not 2026-02-30. */
export const SgDate = z.string().refine((s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.toISOString().slice(0, 10) === s;
}, 'Enter a date like 2026-10-31');

export const FactType = z.enum(['product', 'faq', 'policy', 'promotion']);
export type FactType = z.infer<typeof FactType>;

const promotionRules = (
  b: {
    value: { price?: string | undefined };
    gstTreatment?: unknown;
    validFrom?: string | null | undefined;
    validUntil?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  if (b.value.price !== undefined && !b.gstTreatment)
    ctx.addIssue({
      code: 'custom',
      path: ['gstTreatment'],
      message: 'Choose whether the price includes GST',
    });
  if (b.value.price === undefined && b.gstTreatment)
    ctx.addIssue({
      code: 'custom',
      path: ['gstTreatment'],
      message: 'A promotion without a price has no GST treatment',
    });
  if (b.validFrom && b.validUntil && b.validFrom > b.validUntil)
    ctx.addIssue({
      code: 'custom',
      path: ['validUntil'],
      message: 'The end date must be on or after the start date',
    });
};

export const CreateFactBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('product'),
      value: ProductValueInput,
      gstTreatment: ManualGstTreatment,
    })
    .strict(),
  z
    .object({
      type: z.literal('faq'),
      value: FaqValueInput,
      gstTreatment: z.null().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('policy'),
      value: PolicyValueInput,
      gstTreatment: z.null().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('promotion'),
      value: PromotionValueInput,
      gstTreatment: ManualGstTreatment.nullable().optional(),
      validFrom: SgDate.nullable().optional(),
      validUntil: SgDate,
    })
    .strict()
    .superRefine(promotionRules),
]);
export type CreateFactBody = z.infer<typeof CreateFactBody>;

/** `value` is checked against the fact's own type by the route; validity is for promotions. */
export const UpdateFactBody = z
  .object({
    version: z.int().min(1),
    value: z.record(z.string(), z.unknown()).optional(),
    gstTreatment: ManualGstTreatment.optional(),
    validFrom: SgDate.nullable().optional(),
    validUntil: SgDate.optional(),
    status: z.enum(['approved', 'disabled']).optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.value !== undefined ||
      b.gstTreatment !== undefined ||
      b.validFrom !== undefined ||
      b.validUntil !== undefined ||
      b.status !== undefined,
    { message: 'Nothing to change' },
  );
export type UpdateFactBody = z.infer<typeof UpdateFactBody>;

const factBase = {
  id: z.uuid(),
  status: FactStatus,
  version: z.int(),
  source: z.string(),
  updatedAt: z.iso.datetime({ offset: true }),
  /** Promotions: the first and last day they run, in Singapore (null for other types). */
  validFrom: SgDate.nullable(),
  validUntil: SgDate.nullable(),
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
  z.object({
    ...factBase,
    type: z.literal('policy'),
    value: z.object({ kind: PolicyKind, title: z.string(), details: z.string() }),
    gstTreatment: z.null(),
  }),
  z.object({
    ...factBase,
    type: z.literal('promotion'),
    value: z.object({ title: z.string(), details: z.string(), price: Money.optional() }),
    gstTreatment: GstTreatment.nullable(),
  }),
]);
export type Fact = z.infer<typeof Fact>;

export const FactListQuery = z.object({
  status: FactStatus.optional(),
  type: FactType.optional(),
  /** Priced facts whose GST treatment needs review (KB-15). */
  gst: z.literal('unknown').optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type FactListQuery = z.infer<typeof FactListQuery>;
export const FactList = z.object({ facts: z.array(Fact), nextCursor: z.string().nullable() });
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
