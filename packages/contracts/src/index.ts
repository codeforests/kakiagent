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
  /** What the notice is (FEAT-025): `chat_ended` closes the widget's composer. */
  noticeKind: z.enum(['after_hours', 'chat_ended']).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Message = z.infer<typeof Message>;

export const ConversationSummary = z.object({
  id: z.uuid(),
  channel: z.enum(['widget']),
  status: z.enum(['ai', 'human', 'closed']),
  lastMessageAt: z.iso.datetime({ offset: true }),
  lastMessage: z.string().nullable(),
  /** When the conversation was first flagged for staff, and why (AGT-13, FEAT-025). */
  flaggedAt: z.iso.datetime({ offset: true }).nullable(),
  flagReasons: z.array(z.enum(['abuse', 'crisis'])),
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
  /** The tenant's assistant name, or "Assistant" (FEAT-024). */
  botName: z.string(),
  /** The empty-chat greeting per panel language, already resolved to the default (FEAT-024). */
  greeting: z.object({ en: z.string(), zh: z.string() }),
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

// ---- Dashboard API: assistant settings (AGT-08, AGT-11; FEAT-024 §3) ----------------

/** A tenant text per language; null (or blank, read as null) = the default (FEAT-024 D3). */
const tenantText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .nullable()
    .transform((s) => (s ? s : null));
const LocalText = (max: number, label: string) =>
  z.object({ en: tenantText(max, label), zh: tenantText(max, label) });

export const Tone = z.enum(['friendly', 'professional']);
export type Tone = z.infer<typeof Tone>;

/** Letters in any script, marks, spaces, apostrophes, hyphens and full stops; no digits (D6). */
export const BotName = z
  .string()
  .trim()
  .max(30, 'Assistant name must be 30 characters or fewer')
  .refine((s) => !/\d/.test(s), "Assistant name can't contain numbers")
  .refine(
    (s) => s === '' || /^[\p{L}\p{M}][\p{L}\p{M} '’.-]*$/u.test(s),
    'Use letters, spaces, apostrophes, hyphens or full stops in the assistant name',
  )
  .nullable()
  .transform((s) => (s ? s : null));

export const AssistantSettingsBody = z.object({
  /** The version read; 0 = never saved. */
  version: z.number().int().min(0),
  botName: BotName,
  tone: Tone,
  emoji: z.boolean(),
  greeting: LocalText(200, 'Greeting'),
  disclosureNote: LocalText(200, 'Disclosure addition'),
  afterHoursMessage: LocalText(300, 'After-hours message'),
  fallbackMessage: LocalText(300, 'Fallback message'),
});
export type AssistantSettingsBody = z.infer<typeof AssistantSettingsBody>;
/** What the form holds before parsing (texts may be blank). */
export type AssistantSettingsInput = z.input<typeof AssistantSettingsBody>;

const PerLang = <T extends z.ZodType>(t: T) => z.object({ en: t, zh: t });

export const AssistantSettings = AssistantSettingsBody.extend({
  updatedAt: z.iso.datetime().nullable(),
});
export type AssistantSettings = z.infer<typeof AssistantSettings>;

export const AssistantDefaults = z.object({
  botName: z.string(),
  greeting: PerLang(z.string()),
  afterHoursMessage: PerLang(z.string()),
  fallbackMessage: PerLang(z.string()),
  /** The fixed core with the business name; `{name}` is replaced by the bot name. */
  disclosureCore: PerLang(z.object({ named: z.string(), unnamed: z.string() })),
  /** The return-time sentence, with `{when}` for the next opening. */
  afterHoursLead: PerLang(z.string()),
});
export type AssistantDefaults = z.infer<typeof AssistantDefaults>;

export const AssistantSettingsResponse = z.object({
  settings: AssistantSettings,
  defaults: AssistantDefaults,
});
export type AssistantSettingsResponse = z.infer<typeof AssistantSettingsResponse>;

// ---- Dashboard API: business profile (ONB-03, ONB-06; FEAT-009 §3) ----------------

export const Industry = z.enum([
  'fnb',
  'retail',
  'beauty_wellness',
  'education',
  'professional_services',
  'home_services',
  'other',
]);
export type Industry = z.infer<typeof Industry>;

export const ProfileLanguage = z.enum(['en', 'zh', 'ms', 'ta']);
export type ProfileLanguage = z.infer<typeof ProfileLanguage>;

/** ACRA UEN formats (FEAT-009 D2): business, local company, other entity. */
export const UEN_RE =
  /^([0-9]{8}[A-Z]|(18|19|20)[0-9]{7}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$/;
export const Uen = z
  .string()
  .transform((s) => s.replace(/\s+/g, '').toUpperCase())
  .refine((s) => s === '' || UEN_RE.test(s), 'UEN must be 9 or 10 characters, like 201912345K')
  .nullable()
  .transform((s) => (s ? s : null));

/** Singapore numbers (FEAT-009 D3), stored as `+65XXXXXXXX`. */
export const SgPhone = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .transform((s) => (s.startsWith('+65') ? s.slice(3) : s.startsWith('0065') ? s.slice(4) : s))
  .refine(
    (s) => s === '' || /^[3689][0-9]{7}$/.test(s),
    'Enter a Singapore number with 8 digits, like 9123 4567',
  )
  .transform((s) => (s ? `+65${s}` : null))
  .nullable()
  .transform((s) => s ?? null);

/** `+6591234567` → `+65 9123 4567`. */
export const formatSgPhone = (p: string) => `+65 ${p.slice(3, 7)} ${p.slice(7)}`;

export const ContactEmail = z
  .string()
  .trim()
  .refine(
    (s) => s === '' || (s.length <= 254 && z.email().safeParse(s).success),
    'Enter an email address, like hello@example.com',
  )
  .nullable()
  .transform((s) => (s ? s : null));

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** `24:00` counts as 1440, the end of the day. */
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export const HoursInterval = z.object({
  open: z.string().regex(TIME_RE, 'Enter an opening time'),
  close: z.union([z.string().regex(TIME_RE), z.literal('24:00')], 'Enter a closing time'),
});
export type HoursInterval = z.infer<typeof HoursInterval>;

/** One day's intervals; the message names the day (FEAT-009 ui-design). */
const HoursDay = (day: Weekday) =>
  z
    .array(HoursInterval)
    .max(4, `${WEEKDAY_NAMES[day]}: up to 4 time ranges`)
    .superRefine((d, ctx) => {
      d.forEach((i, k) => {
        if (!TIME_RE.test(i.open)) return;
        if (minutes(i.open) >= minutes(i.close))
          ctx.addIssue({
            code: 'custom',
            path: [k],
            message: `${WEEKDAY_NAMES[day]}: opening time must be before closing time`,
          });
        else if (k > 0 && minutes(d[k - 1]!.close) > minutes(i.open))
          ctx.addIssue({
            code: 'custom',
            path: [k],
            message: `${WEEKDAY_NAMES[day]}: hours overlap`,
          });
      });
    });

/** Weekly hours in SGT, the same rules as @kaki/tenancy's `WeeklyHours` (FEAT-023 §4). */
export const WeeklyHoursInput = z.object(
  Object.fromEntries(WEEKDAYS.map((d) => [d, HoursDay(d)])) as Record<
    Weekday,
    ReturnType<typeof HoursDay>
  >,
);
export type WeeklyHoursInput = z.infer<typeof WeeklyHoursInput>;

export const HolidayException = z.object({
  day: z.string().min(1, 'Choose a date for each closure').pipe(SgDate),
  kind: z.enum(['open', 'closed']),
  label: z
    .string()
    .trim()
    .max(60, 'A closure reason must be 60 characters or fewer')
    .nullable()
    .transform((s) => (s ? s : null)),
});
export type HolidayException = z.infer<typeof HolidayException>;

export const BusinessProfileBody = z.object({
  version: z.number().int().min(1),
  name: z
    .string()
    .trim()
    .min(1, 'Enter your business name')
    .max(120, 'Business name must be 120 characters or fewer'),
  uen: Uen,
  industry: Industry.nullable(),
  contactEmail: ContactEmail,
  contactPhone: SgPhone,
  languages: z
    .array(ProfileLanguage)
    .min(1, 'Choose at least one language')
    .refine((l) => new Set(l).size === l.length, 'Choose each language once'),
  gstRegistered: z.boolean(),
  hours: WeeklyHoursInput.nullable(),
  openOnPublicHolidays: z.boolean(),
  exceptions: z
    .array(HolidayException)
    .max(60, 'Up to 60 holidays and closures')
    .refine(
      (e) => new Set(e.map((x) => x.day)).size === e.length,
      'Each date can only be listed once',
    ),
});
export type BusinessProfileBody = z.infer<typeof BusinessProfileBody>;
/** What the form holds before parsing. */
export type BusinessProfileInput = z.input<typeof BusinessProfileBody>;

/**
 * The exception rules that need the SG calendar and today's date (FEAT-009 §3.1), which
 * this package doesn't hold: the api passes @kaki/tenancy's calendar, the dashboard the
 * response's. Paths point into `exceptions`.
 */
export function exceptionIssues(
  b: Pick<BusinessProfileBody, 'exceptions' | 'openOnPublicHolidays'>,
  ctx: { isHoliday: (day: string) => boolean; today: string },
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  b.exceptions.forEach((e, i) => {
    const at = ['exceptions', i, 'day'];
    if (e.day < ctx.today) issues.push({ path: at, message: "A closure can't be in the past" });
    else if (e.kind === 'open' && (!ctx.isHoliday(e.day) || b.openOnPublicHolidays))
      issues.push({ path: at, message: 'Only a public holiday you close on can be marked open' });
    else if (e.kind === 'closed' && ctx.isHoliday(e.day) && !b.openOnPublicHolidays)
      issues.push({ path: at, message: "You're already closed on this public holiday" });
  });
  return issues;
}

export const BusinessProfile = BusinessProfileBody.extend({ updatedAt: z.iso.datetime() });
export type BusinessProfile = z.infer<typeof BusinessProfile>;

export const PublicHoliday = z.object({ day: z.string(), name: z.string() });
export type PublicHoliday = z.infer<typeof PublicHoliday>;

export const SuggestedFaq = z.object({
  id: z.string(),
  question: z.string(),
  hint: z.string(),
  added: z.boolean(),
});
export type SuggestedFaq = z.infer<typeof SuggestedFaq>;

export const BusinessProfileResponse = z.object({
  profile: BusinessProfile,
  calendar: z.object({ holidays: z.array(PublicHoliday), coverThrough: z.int() }),
  template: z.object({ industry: Industry, suggestedFaqs: z.array(SuggestedFaq) }).nullable(),
});
export type BusinessProfileResponse = z.infer<typeof BusinessProfileResponse>;

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
