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
  /** The reply's language as the agent decided it (FEAT-033): sets the widget's chrome locale. Null on visitor and staff messages. */
  language: z.enum(['en', 'zh']).nullable(),
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

/** A colour as `#rrggbb`, lower-cased on parse (FEAT-032 §3). */
export const Hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((h) => h.toLowerCase());
export const FontChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('site') }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
  z
    .object({
      kind: z.literal('custom'),
      family: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[\w \-,'"]+$/),
    })
    .strict(),
]);
export type FontChoice = z.infer<typeof FontChoice>;
/** The owner's overrides; an absent key follows the site (CHN-14, D5: clamped too). */
export const ThemeOverrides = z
  .object({
    accent: Hex.optional(),
    font: FontChoice.optional(),
    radius: z.int().min(0).max(20).optional(),
    scheme: z.enum(['light', 'dark']).optional(),
  })
  .strict();
export type ThemeOverrides = z.infer<typeof ThemeOverrides>;
/** What the server-side detection found on the tenant's site (ADR-016 decision 5). */
export const DetectedTheme = z.object({
  accent: Hex.nullable(),
  font: z.string().max(200).nullable(),
  radius: z.number().min(0).nullable(),
  scheme: z.enum(['light', 'dark']),
  url: z.string(),
  detectedAt: z.iso.datetime({ offset: true }),
});
export type DetectedTheme = z.infer<typeof DetectedTheme>;
export const WidgetPosition = z.enum(['right', 'left']);
export type WidgetPosition = z.infer<typeof WidgetPosition>;
export const WidgetTheme = z.object({
  position: WidgetPosition,
  overrides: ThemeOverrides,
  detected: DetectedTheme.nullable(),
  logoUrl: z.url().nullable(),
});
export type WidgetTheme = z.infer<typeof WidgetTheme>;

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
  /** The widget's look: position, overrides, stored detection, logo (FEAT-032). */
  theme: WidgetTheme,
  /** The tenant's privacy notice (GOV-14; FEAT-058): its own https link, the hosted template page, or null (no link). */
  privacyNoticeUrl: z.url().nullable(),
  /** Visitor controls the tenant can offer (CHN-13). `talkToPerson` stays false until FEAT-044. */
  controls: z.object({ talkToPerson: z.boolean() }),
  /**
   * Whether the widget channel is live (ONB-10; FEAT-034). Offline: `hidden` → the loader
   * doesn't mount; `message` → the panel shows the resolved text and the business contacts.
   */
  availability: z.discriminatedUnion('live', [
    z.object({ live: z.literal(true) }),
    z.object({
      live: z.literal(false),
      mode: z.enum(['hidden', 'message']),
      message: z.object({ en: z.string(), zh: z.string() }),
      contact: z.object({ email: z.string().nullable(), phone: z.string().nullable() }),
    }),
  ]),
  /** Kill switch (GOV-08; FEAT-057): null while the AI runs. Paused → the panel shows this notice above the composer. */
  aiPaused: z
    .object({
      message: z.object({ en: z.string(), zh: z.string() }),
      contact: z.object({ email: z.string().nullable(), phone: z.string().nullable() }),
    })
    .nullable(),
});
export type WidgetConfigResponse = z.infer<typeof WidgetConfigResponse>;

export const CreateConversationResponse = z.object({ conversationId: z.uuid() });

export const SendMessageBody = z.object({
  text: z.string().trim().min(1).max(4000),
  clientMessageId: z.string().min(8).max(64),
});
export const SendMessageResponse = z.object({ message: Message });

// ---- Widget API: visitor controls (CHN-13; FEAT-033 §3) ---------------------------

/** `POST /widget/v1/conversations/:id/end`: idempotent, the conversation is closed. */
export const EndConversationResponse = z.object({ status: z.literal('closed') });
export type EndConversationResponse = z.infer<typeof EndConversationResponse>;

// ---- Dashboard API (api role) ----------------------------------------------------

export const Role = z.enum(['owner', 'admin', 'agent']);
export type Role = z.infer<typeof Role>;

/** The signed-in user; role and tenant are null until they have a workspace (FEAT-005 D10). */
export const Me = z.object({
  /** `displayName` is the profile name (AUTH-05; FEAT-008), null until set. */
  user: z.object({ id: z.uuid(), email: z.string(), displayName: z.string().nullable() }),
  role: Role.nullable(),
  tenant: z
    .object({ id: z.uuid(), name: z.string(), status: z.enum(['active', 'suspended']) })
    .nullable(),
  /** Owner, Admin, or an Agent with the Owner's grant (D3; FEAT-007 §3). FEAT-055 reads it. */
  canApprove: z.boolean(),
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
  /** An invitation token from SCR-APP-004: the link then joins it on verify (FEAT-007 D4). */
  invitation: z.string().max(100).optional(),
});
/** The same for every well-formed address (AUTH-01); `delayed` when email is slow (UC-01 2c). */
export const MagicLinkResponse = z.object({ delayed: z.boolean() });

export const MagicLinkVerifyBody = z.object({ token: z.string().max(100) });
/**
 * Where the dashboard goes next. FEAT-006: `mfa` (the code challenge), `mfa-enrol` (forced
 * enrolment) and `reauthed` (a re-auth link was confirmed; "go back to your tab").
 */
export const MagicLinkVerifyResponse = z.object({
  next: z.enum(['app', 'create-workspace', 'mfa', 'mfa-enrol', 'reauthed']),
});
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
  /** Facts from a source (FEAT-012): its ID, the extractor's confidence, where it was found. */
  sourceId: z.uuid().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  provenance: z.lazy(() => Provenance).nullable(),
};
export const Fact = z.discriminatedUnion('type', [
  z.object({
    ...factBase,
    type: z.literal('product'),
    value: z.object({
      name: z.string(),
      price: Money,
      unit: z.string().optional(),
      /** From an imported spreadsheet (FEAT-016 D8): shown, never quoted (architecture Q6). */
      sku: z.string().optional(),
      stock: z.int().min(0).optional(),
      stockAsOf: z.string().optional(),
    }),
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
  /** The facts one source produced (FEAT-012 §3.2). */
  sourceId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type FactListQuery = z.infer<typeof FactListQuery>;
export const FactList = z.object({ facts: z.array(Fact), nextCursor: z.string().nullable() });
export const FactResponse = z.object({ fact: Fact });

// ---- Dashboard API: knowledge sources (KB-01, KB-12, KB-13; FEAT-012 §3) ------------

export const SourceKind = z.enum(['website', 'file', 'spreadsheet', 'chat']);
export const SourceStatus = z.enum(['queued', 'processing', 'ready', 'failed']);
export type SourceStatus = z.infer<typeof SourceStatus>;
/** `map`: waiting for the owner's column mapping (FEAT-016 D3); `import`: applying it. */
export const SourceStage = z.enum([
  'scan',
  'parse',
  'map',
  'import',
  'crawl',
  'extract',
  'promote',
]);
export const SourceFailure = z.enum([
  'no_pages',
  'site_unreachable',
  'extraction_unavailable',
  'internal',
  // Files (FEAT-015 §3.1): the safety checks (KB-11), then reading (KB-02).
  'upload_missing',
  'too_large',
  'unsupported_type',
  'encrypted',
  'malware',
  'scan_unavailable',
  'unreadable',
  'no_text',
  // Spreadsheets (FEAT-016 §3.1).
  'no_rows',
  'no_valid_rows',
  // Chat exports (FEAT-017 §3.1): not an export we can read (UC-11 2a), or no business message.
  'chat_format',
  'business_not_found',
]);
export type SourceFailure = z.infer<typeof SourceFailure>;
export const PageStatus = z.enum(['included', 'excluded', 'failed', 'skipped']);
export type PageStatus = z.infer<typeof PageStatus>;
export const PageReason = z.enum([
  'robots',
  'off_domain_redirect',
  'not_html',
  'duplicate',
  'timeout',
  'http_error',
  'blocked_address',
  'load_error',
  'plan_limit',
  'no_text',
  'page_limit',
  'ocr_limit',
  // Spreadsheet rows (FEAT-016 §5.5).
  'empty_row',
  'no_name',
  'no_price',
  'bad_price',
  'not_sgd',
  'bad_stock',
  'too_long',
]);
export type PageReason = z.infer<typeof PageReason>;

/**
 * Where in a file a page is (FEAT-015 §3.1): its pages, slides, parts, or the image; or a
 * spreadsheet's row (FEAT-016), numbered as in the sheet; or a chat export's conversation
 * part (FEAT-017).
 */
export const FileLocation = z.object({
  unit: z.enum(['page', 'slide', 'part', 'image', 'row', 'chat']),
  number: z.int().min(1),
});
export type FileLocation = z.infer<typeof FileLocation>;

export const Provenance = z.object({
  sourceId: z.uuid(),
  /** A web page's URL, or a file page's locator (`page/3`, `slide/2`, `part/1`, `image/1`). */
  url: z.string(),
  title: z.string().nullable(),
  quote: z.string(),
  start: z.int().min(0),
  end: z.int().min(0),
  /** Set for facts from files. */
  location: FileLocation.nullable(),
});
export type Provenance = z.infer<typeof Provenance>;

export const FileType = z.enum([
  'pdf',
  'docx',
  'pptx',
  'txt',
  'jpeg',
  'png',
  'xlsx',
  'csv',
  'json',
  'zip',
]);
export type FileType = z.infer<typeof FileType>;

export const Source = z.object({
  id: z.uuid(),
  kind: SourceKind,
  status: SourceStatus,
  stage: SourceStage.nullable(),
  /** The domain, e.g. "kakibakery.sg", or the file's name. */
  name: z.string(),
  /** Websites only; null for files. */
  url: z.string().nullable(),
  domain: z.string().nullable(),
  subdomains: z.array(z.string()),
  pageLimit: z.int().nullable(),
  failure: SourceFailure.nullable(),
  /** Failed for a reason a retry can fix; files rejected by the safety checks can't be (D7). */
  retryable: z.boolean(),
  /** Files only (FEAT-015): `type` is what the bytes showed, null until the scan. */
  file: z
    .object({
      name: z.string(),
      sizeBytes: z.int(),
      type: FileType.nullable(),
      ocrPages: z.int(),
      scannedAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .nullable(),
  /** Spreadsheets only (FEAT-016 §3.1), once the parse has read the sheet. */
  sheet: z.lazy(() => SheetLayout).nullable(),
  /** Chat exports only (FEAT-017 §3.1), once the parse has read and redacted the export. */
  chat: z.lazy(() => ChatSummary).nullable(),
  counts: z.object({
    pagesFound: z.int(),
    pagesIncluded: z.int(),
    pagesExcluded: z.int(),
    pagesFailed: z.int(),
    pagesSkipped: z.int(),
    pagesExtracted: z.int(),
    facts: z.int(),
    factsNeedingReview: z.int(),
  }),
  attestedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  version: z.int(),
});
export type Source = z.infer<typeof Source>;

export const SourcePage = z.object({
  id: z.uuid(),
  url: z.string(),
  title: z.string().nullable(),
  status: PageStatus,
  reason: PageReason.nullable(),
  httpStatus: z.int().nullable(),
  facts: z.int(),
  /** 0..1 when the page was read by OCR (FEAT-015). */
  ocrConfidence: z.number().min(0).max(1).nullable(),
  /** A spreadsheet row's cells, masked (FEAT-016); null for other pages. */
  cells: z.array(z.string()).nullable(),
});
export type SourcePage = z.infer<typeof SourcePage>;

/** The file names an upload may have (KB-02); the bytes decide what a file is (FEAT-015 D5). */
export const FILE_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.txt', '.jpg', '.jpeg', '.png'] as const;
/** Spreadsheets imported row by row (KB-03; FEAT-016). */
export const SHEET_EXTENSIONS = ['.xlsx', '.csv'] as const;
/** Chat exports mined for suggested FAQs (KB-04; FEAT-017): WhatsApp .txt or .zip, Telegram .json. */
export const CHAT_EXTENSIONS = ['.txt', '.zip', '.json'] as const;
/** What `POST /kb/uploads` accepts: files, spreadsheets and chat exports share the upload path. */
export const UPLOAD_EXTENSIONS = [
  ...new Set([...FILE_EXTENSIONS, ...SHEET_EXTENSIONS, ...CHAT_EXTENSIONS]),
] as readonly string[];
/** KB-02: up to 25 MB each. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const FileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((n) => !/[/\\\p{Cc}]/u.test(n), { message: 'Not a file name' });

const WebsiteSourceBody = z
  .object({
    kind: z.literal('website'),
    url: z.string().trim().min(1).max(2000),
    subdomains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
    attested: z.boolean().optional(),
  })
  .strict();
/**
 * An uploaded file becomes a source once its PUT is done (FEAT-015 §3.2, D2); a
 * spreadsheet the same way, with its own kind (FEAT-016 §3.2).
 */
const fileBody = <K extends 'file' | 'spreadsheet'>(kind: K) =>
  z
    .object({
      kind: z.literal(kind),
      uploadId: z.uuid(),
      fileName: FileName,
      /** As declared for the upload; the scan stores the object's real size. */
      sizeBytes: z.int().min(1),
    })
    .strict();
const FileSourceBody = fileBody('file');
const SpreadsheetSourceBody = fileBody('spreadsheet');
/**
 * A chat export (FEAT-017 §3.2): `fileName` is checked for its extension and never stored
 * (it usually names the customer); `businessNames` are how the business appears in the chat.
 */
const ChatSourceBody = z
  .object({
    kind: z.literal('chat'),
    uploadId: z.uuid(),
    fileName: FileName,
    sizeBytes: z.int().min(1),
    businessNames: z.array(z.string().trim().min(1).max(100)).min(1).max(5),
  })
  .strict();
/** `attested` is checked by the route, so a missing one gets its own error (UC-03 4b). */
export const CreateSourceBody = z.discriminatedUnion('kind', [
  WebsiteSourceBody,
  FileSourceBody,
  SpreadsheetSourceBody,
  ChatSourceBody,
]);
export type CreateSourceBody = z.infer<typeof CreateSourceBody>;

/** A presigned upload to the quarantine bucket (KB-11; FEAT-015 §3.2). */
export const UploadRequestBody = z
  .object({ fileName: FileName, sizeBytes: z.int().min(1) })
  .strict();
export type UploadRequestBody = z.infer<typeof UploadRequestBody>;
export const UploadTicket = z.object({
  uploadId: z.uuid(),
  url: z.string(),
  /** Headers the PUT must send as they are (the signed length). */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type UploadTicket = z.infer<typeof UploadTicket>;
export const RetrySourceBody = z.object({ version: z.int().min(1) }).strict();
export const SourceList = z.object({
  sources: z.array(Source),
  pageLimit: z.int(),
  /** How many file sources the plan holds, and the size limit (FEAT-015). */
  fileLimit: z.int(),
  maxFileBytes: z.int(),
});
export type SourceList = z.infer<typeof SourceList>;
export const SourceResponse = z.object({ source: Source });
export const SourceDetail = z.object({ source: Source, pages: z.array(SourcePage) });
export type SourceDetail = z.infer<typeof SourceDetail>;

// ---- Dashboard API: chat-history import (KB-04; FEAT-017 §3) ------------------------

export const ChatFormat = z.enum(['whatsapp', 'telegram']);
export type ChatFormat = z.infer<typeof ChatFormat>;
/** What the parse read and removed; counts only (NFR-11). */
export const ChatSummary = z.object({
  format: ChatFormat,
  from: SgDate,
  to: SgDate,
  messages: z.int(),
  messagesSkipped: z.int(),
  businessMessages: z.int(),
  conversations: z.int(),
  exchanges: z.int(),
  redacted: z.object({
    names: z.int(),
    phones: z.int(),
    emails: z.int(),
    ids: z.int(),
    addresses: z.int(),
  }),
  exportDeletedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

// ---- Dashboard API: spreadsheet import (KB-03; FEAT-016 §3) -------------------------

/** The fields a column can map to; product and service both name the fact (§3.1). */
export const SheetField = z.enum(['product', 'service', 'price', 'unit', 'sku', 'stock']);
export type SheetField = z.infer<typeof SheetField>;
export const SHEET_FIELDS = SheetField.options;
/** Field → 0-based column index; checked against the sheet by the route (`bad_mapping`). */
export const ColumnMapping = z
  .object(
    Object.fromEntries(SHEET_FIELDS.map((f) => [f, z.int().min(0).max(49).optional()])) as Record<
      SheetField,
      z.ZodOptional<z.ZodInt>
    >,
  )
  .strict();
export type ColumnMapping = z.infer<typeof ColumnMapping>;
/** The import's GST choice (UC-10 step 4); `unknown` holds a registered tenant's prices back. */
export const SheetGst = GstTreatment;
export type SheetGst = z.infer<typeof SheetGst>;

export const SheetLayout = z.object({
  /** The worksheet read (XLSX); null for CSV. */
  name: z.string().nullable(),
  headerRow: z.int().min(1),
  rows: z.int().min(0),
  rowsSkipped: z.int().min(0),
  columns: z.array(z.object({ index: z.int(), header: z.string(), samples: z.array(z.string()) })),
  suggested: z.object({ columns: ColumnMapping, gst: SheetGst.nullable() }),
  mapping: z
    .object({
      columns: ColumnMapping,
      gst: SheetGst,
      confirmedAt: z.iso.datetime({ offset: true }),
    })
    .nullable(),
});
export type SheetLayout = z.infer<typeof SheetLayout>;

export const ImportBody = z.object({ mapping: ColumnMapping, gst: SheetGst }).strict();
export type ImportBody = z.infer<typeof ImportBody>;
export const ConfirmImportBody = ImportBody.extend({ version: z.int().min(1) }).strict();
export type ConfirmImportBody = z.infer<typeof ConfirmImportBody>;

export const PreviewRow = z.object({
  row: z.int(),
  cells: z.array(z.string()),
  reason: PageReason.nullable(),
  fact: z
    .object({
      name: z.string(),
      price: Money,
      unit: z.string().nullable(),
      sku: z.string().nullable(),
      stock: z.int().nullable(),
    })
    .nullable(),
  /** Disagrees with a fact the tenant has, or with another row (KB-06). */
  conflict: z.boolean(),
});
export type PreviewRow = z.infer<typeof PreviewRow>;
export const ImportPreview = z.object({
  rows: z.int(),
  importable: z.int(),
  rejected: z.int(),
  empty: z.int(),
  duplicates: z.int(),
  /** Rows the KB already has with the same value; not written again. */
  existing: z.int(),
  /** Importable rows that will be written conflicted. */
  conflicts: z.int(),
  /** Importable rows held back from visitors until their GST treatment is set (KB-15). */
  gstReview: z.int(),
  sample: z.array(PreviewRow),
  rejects: z.array(PreviewRow),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

// ---- Dashboard API: fact review (KB-16; FEAT-013 §3) --------------------------------

/** "By source or by entity type" (KB-16). */
export const ReviewScopeQuery = z
  .object({ sourceId: z.uuid().optional(), type: FactType.optional() })
  .strict();
export type ReviewScopeQuery = z.infer<typeof ReviewScopeQuery>;
export const ReviewListQuery = ReviewScopeQuery.extend({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ReviewListQuery = z.infer<typeof ReviewListQuery>;

/** The quote inside its page text, cut at words (FEAT-013 D6). Text, never HTML. */
export const Passage = z.object({ before: z.string(), quote: z.string(), after: z.string() });
export type Passage = z.infer<typeof Passage>;
const reviewExtras = {
  passage: Passage.nullable(),
  /** The source's domain, e.g. "kakibakery.sg"; null for facts without a source. */
  sourceName: z.string().nullable(),
  /** When the source finished reading. */
  sourceCapturedAt: z.iso.datetime({ offset: true }).nullable(),
};
const [productFact, faqFact, policyFact, promotionFact] = Fact.options;
export const ReviewFact = z.discriminatedUnion('type', [
  productFact.extend(reviewExtras),
  faqFact.extend(reviewExtras),
  policyFact.extend(reviewExtras),
  promotionFact.extend(reviewExtras),
]);
export type ReviewFact = z.infer<typeof ReviewFact>;
export const ReviewList = z.object({
  facts: z.array(ReviewFact),
  nextCursor: z.string().nullable(),
});

export const TypeCounts = z.object({
  product: z.int(),
  policy: z.int(),
  promotion: z.int(),
  faq: z.int(),
});
export type TypeCounts = z.infer<typeof TypeCounts>;
export const ReviewSummary = z.object({
  needsReview: z.int(),
  conflicted: z.int(),
  /** Open conflicts: entities whose sources disagree (FEAT-014). */
  conflicts: z.int(),
  byType: TypeCounts,
  bySource: z.array(
    z.object({ id: z.uuid().nullable(), name: z.string().nullable(), count: z.int() }),
  ),
  approvedInUse: z.int(),
  sourcesBusy: z.int(),
  /** Open items in the corrections queue (KB-18, FEAT-018). */
  openCorrections: z.int(),
  /** Approved facts past their review interval (KB-17, FEAT-018). */
  overdueFacts: z.int(),
});
export type ReviewSummary = z.infer<typeof ReviewSummary>;
export const ApprovePreview = z.object({
  scope: ReviewScopeQuery,
  count: z.int(),
  byType: TypeCounts,
  excluded: z.object({ gstUnknown: z.int(), conflicted: z.int() }),
  previewHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApprovePreview = z.infer<typeof ApprovePreview>;

export const FactRef = z.object({ id: z.uuid(), version: z.int().min(1) }).strict();
export type FactRef = z.infer<typeof FactRef>;
const distinctRefs = (max: number) =>
  z
    .array(FactRef)
    .min(1)
    .max(max)
    .refine((refs) => new Set(refs.map((r) => r.id)).size === refs.length, {
      message: 'Each fact once',
    });
export const ApproveAllBody = ReviewScopeQuery.extend({
  previewHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ApproveAllBody = z.infer<typeof ApproveAllBody>;
export const ApproveAllResponse = z.object({ approved: z.int(), facts: z.array(FactRef) });
export const SelectionBody = z.object({ facts: distinctRefs(200) }).strict();
export type SelectionBody = z.infer<typeof SelectionBody>;
export const UndoBody = z.object({ facts: distinctRefs(5000) }).strict();
export type UndoBody = z.infer<typeof UndoBody>;
export const SkipReason = z.enum([
  'gst_unknown',
  'conflicted',
  'not_reviewable',
  'changed',
  'not_found',
]);
export type SkipReason = z.infer<typeof SkipReason>;
const Skipped = z.array(z.object({ id: z.uuid(), reason: SkipReason }));
export const ApproveSelectionResponse = z.object({ approved: z.array(FactRef), skipped: Skipped });
export const RejectSelectionResponse = z.object({ rejected: z.array(FactRef), skipped: Skipped });
export const UndoResponse = z.object({ restored: z.int(), skipped: Skipped });

/** "Edit and approve" sends the edit fields of `UpdateFactBody`; none means approve as is. */
export const ApproveFactBody = z
  .object({
    version: z.int().min(1),
    value: z.record(z.string(), z.unknown()).optional(),
    gstTreatment: ManualGstTreatment.optional(),
    validFrom: SgDate.nullable().optional(),
    validUntil: SgDate.optional(),
  })
  .strict();
export type ApproveFactBody = z.infer<typeof ApproveFactBody>;
export const RejectFactBody = z.object({ version: z.int().min(1) }).strict();

// ---- Dashboard API: conflicts (KB-06, UC-12; FEAT-014 §3) ---------------------------

const conflictExtras = {
  /** When this source said it: its read time, or the owner's last confirmation (D4). */
  sourceDate: z.iso.datetime({ offset: true }),
  /** The strictly newest member, suggested (KB-17). */
  newer: z.boolean(),
};
export const ConflictFact = z.discriminatedUnion('type', [
  productFact.extend(reviewExtras).extend(conflictExtras),
  faqFact.extend(reviewExtras).extend(conflictExtras),
  policyFact.extend(reviewExtras).extend(conflictExtras),
  promotionFact.extend(reviewExtras).extend(conflictExtras),
]);
export type ConflictFact = z.infer<typeof ConflictFact>;
export const Conflict = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  type: FactType,
  facts: z.array(ConflictFact).min(1),
  suggestedId: z.uuid().nullable(),
});
export type Conflict = z.infer<typeof Conflict>;
export const ConflictList = z.object({ conflicts: z.array(Conflict) });
export type ConflictList = z.infer<typeof ConflictList>;

const resolveBase = { facts: distinctRefs(50), keepId: z.uuid() };
const keptAmong = (b: { facts: FactRef[]; keepId: string }) =>
  b.facts.some((f) => f.id === b.keepId);
export const ResolveConflictBody = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('use'),
        ...resolveBase,
        gstTreatment: ManualGstTreatment.optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal('enter'),
        ...resolveBase,
        value: z.record(z.string(), z.unknown()),
        gstTreatment: ManualGstTreatment.optional(),
        validFrom: SgDate.nullable().optional(),
        validUntil: SgDate.optional(),
      })
      .strict(),
    z.object({ action: z.literal('disable'), ...resolveBase }).strict(),
  ])
  .refine(keptAmong, { message: 'Keep one of the facts', path: ['keepId'] });
export type ResolveConflictBody = z.infer<typeof ResolveConflictBody>;
export const ResolveConflictResponse = z.object({ fact: Fact, rejected: z.array(FactRef) });
export type ResolveConflictResponse = z.infer<typeof ResolveConflictResponse>;

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

// ---- Dashboard API: coaching (AGT-17, ONB-05; FEAT-027 §3) ---------------------------

export const CoachOrigin = z.enum(['coach', 'setup', 'panel', 'replay']);
export type CoachOrigin = z.infer<typeof CoachOrigin>;
export const CoachSessionCreate = z.object({ origin: CoachOrigin });
export const CoachSession = z.object({
  id: z.uuid(),
  origin: CoachOrigin,
  title: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type CoachSession = z.infer<typeof CoachSession>;
export const CoachSessionResponse = z.object({ session: CoachSession });
export const CoachSessionList = z.object({
  sessions: z.array(CoachSession),
  nextCursor: z.string().nullable(),
});
export const CoachSessionListQuery = z.object({
  cursor: z.string().min(1).max(200).optional(),
});

export const CoachOutcome = z.enum([
  'answered',
  'escalated',
  'out_of_scope',
  'unsure',
  'refused',
  'unavailable',
  /** A safety task ended the turn (replay only, FEAT-028 §3). */
  'ended',
]);
export type CoachOutcome = z.infer<typeof CoachOutcome>;
export const ReasonCode = z.enum([
  'matched_facts',
  'no_matching_fact',
  'low_confidence',
  'out_of_scope',
  'advice',
  'illegal',
  'injection',
  'impersonation',
  'regenerated',
  'segment_blocked',
  'escalated',
  'hours_slot',
  'unreviewed_used',
  'crisis',
  'abuse_warning',
  'abuse_ended',
]);
export type ReasonCode = z.infer<typeof ReasonCode>;
export const ExplainedFact = z.object({
  id: z.uuid(),
  type: FactType,
  label: z.string(),
  status: z.enum(['approved', 'needs_review']),
  used: z.boolean(),
});
export type ExplainedFact = z.infer<typeof ExplainedFact>;
export const VisitorsWouldGet = z.enum([
  'same',
  'without_unreviewed',
  'fallback_paused',
  'not_live',
]);
export const Explainer = z.object({
  outcome: CoachOutcome,
  facts: z.array(ExplainedFact),
  usedFactIds: z.array(z.uuid()),
  reasons: z.array(ReasonCode),
  route: z.enum(['reply.simple', 'reply.complex']).nullable(),
  visitorsWouldGet: VisitorsWouldGet,
});
export type Explainer = z.infer<typeof Explainer>;

/** A fact's content as a correction shows it: the value plus GST treatment and validity. */
export const FactValueView = z.object({
  value: z.record(z.string(), z.unknown()),
  gstTreatment: GstTreatment.nullable(),
  validFrom: SgDate.nullable(),
  validUntil: SgDate.nullable(),
});
export type FactValueView = z.infer<typeof FactValueView>;
export const ProposedChange = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('edit_fact'),
    factId: z.uuid(),
    factVersion: z.int().min(1),
    factType: FactType,
    label: z.string(),
    before: FactValueView,
    after: FactValueView,
  }),
  z.object({ kind: z.literal('add_faq'), question: z.string(), answer: z.string() }),
  z.object({
    kind: z.literal('edit_hours'),
    profileVersion: z.int().min(0),
    before: WeeklyHoursInput.partial(),
    after: WeeklyHoursInput.partial(),
  }),
  /**
   * A group of visitor questions the assistant couldn't answer (KB-09, FEAT-019 D3): no
   * question text; accepting it needs an `add_faq` edit with the owner's FAQ.
   */
  z.object({ kind: z.literal('answer_gap') }),
  /** A stale fact (KB-17, FEAT-018): accepting it re-confirms the fact and changes no value. */
  z.object({
    kind: z.literal('reconfirm'),
    factId: z.uuid(),
    factVersion: z.int().min(1),
    factType: FactType,
    label: z.string(),
    lastConfirmedAt: z.iso.datetime({ offset: true }),
  }),
]);
export type ProposedChange = z.infer<typeof ProposedChange>;
export const CorrectionStatus = z.enum(['open', 'accepted', 'edited_and_accepted', 'dismissed']);
export const Correction = z.object({
  id: z.uuid(),
  status: CorrectionStatus,
  change: ProposedChange,
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Correction = z.infer<typeof Correction>;

export const CoachMessage = z.object({
  id: z.uuid(),
  seq: z.int(),
  author: z.enum(['owner', 'agent']),
  kind: z.enum(['question', 'answer', 'proposal', 'after', 'replay']),
  text: z.string(),
  includeUnreviewed: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  explainer: Explainer.nullable(),
  correction: Correction.nullable(),
});
export type CoachMessage = z.infer<typeof CoachMessage>;
export const CoachSessionDetail = z.object({
  session: CoachSession,
  messages: z.array(CoachMessage),
});
export const CoachTurnRequest = z.object({
  text: z.string().trim().min(1).max(1000),
  includeUnreviewed: z.boolean(),
});
export type CoachTurnRequest = z.infer<typeof CoachTurnRequest>;
export const CoachTurnResponse = z.object({ question: CoachMessage, answer: CoachMessage });
export type CoachTurnResponse = z.infer<typeof CoachTurnResponse>;
export const CorrectionDecision = z.object({}).strict();
export const CorrectionConfirmResponse = z.object({
  correction: Correction,
  before: CoachMessage.nullable(),
  after: CoachMessage.nullable(),
  /** Past visitor questions the accepted fix replays (FEAT-018 §3); 0 when nothing replays. */
  replayQuestions: z.int().min(0),
});
export type CorrectionConfirmResponse = z.infer<typeof CorrectionConfirmResponse>;
export const CorrectionResponse = z.object({ correction: Correction });
export const CoachSuggestions = z.object({ questions: z.array(z.string()).max(6) });

// ---- Dashboard API: replay (AGT-17, UC-04 4b; FEAT-028 §3) ----------------------------

/** The first 20 visitor questions of a conversation are replayed (D5). */
export const REPLAY_LIMIT = 20;
export const ReplayCandidate = z.object({
  id: z.uuid(),
  channel: z.string(),
  status: z.enum(['ai', 'human', 'closed']),
  startedAt: z.iso.datetime({ offset: true }),
  lastMessageAt: z.iso.datetime({ offset: true }),
  /** Masked, at most 120 characters. */
  firstQuestion: z.string(),
  questions: z.int().min(1),
  flagged: z.boolean(),
  lastReplayId: z.uuid().nullable(),
});
export type ReplayCandidate = z.infer<typeof ReplayCandidate>;
export const ReplayCandidateList = z.object({
  conversations: z.array(ReplayCandidate),
  nextCursor: z.string().nullable(),
});
export const ReplayCandidateQuery = z.object({
  cursor: z.string().min(1).max(200).optional(),
});
export const ReplayCreate = z.object({
  conversationId: z.uuid(),
  includeUnreviewed: z.boolean(),
});
export type ReplayCreate = z.infer<typeof ReplayCreate>;
export const OriginalReply = z.object({
  author: z.enum(['agent', 'staff', 'system']),
  text: z.string(),
  factIds: z.array(z.uuid()),
  createdAt: z.iso.datetime({ offset: true }),
});
export type OriginalReply = z.infer<typeof OriginalReply>;
/** What the dispatcher would have done live, as codes (task kinds from `@kaki/agent`). */
export const ReplayEffect = z.object({
  task: z.string().regex(/^[a-z_]+$/),
  outcome: z.enum(['done', 'refused', 'unhandled']),
});
export type ReplayEffect = z.infer<typeof ReplayEffect>;
export const ReplayTurn = z
  .object({
    messageId: z.uuid(),
    index: z.int().min(0),
    question: z.string(),
    askedAt: z.iso.datetime({ offset: true }),
    original: z.array(OriginalReply),
    status: z.enum(['pending', 'done']),
    replayed: CoachMessage.nullable(),
    effects: z.array(ReplayEffect),
    factsChanged: z.boolean().nullable(),
  })
  .refine((t) => (t.status === 'done') === (t.replayed !== null), {
    message: 'a done turn has its replayed answer, a pending one none',
    path: ['replayed'],
  });
export type ReplayTurn = z.infer<typeof ReplayTurn>;
export const Replay = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  includeUnreviewed: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  totalQuestions: z.int().min(0),
  turns: z.array(ReplayTurn).max(REPLAY_LIMIT),
});
export type Replay = z.infer<typeof Replay>;
export const ReplayResponse = z.object({ replay: Replay });
export const ReplayNextRequest = z.object({}).strict();
export const ReplayNextResponse = z.object({ turn: ReplayTurn, remaining: z.int().min(0) });
export type ReplayNextResponse = z.infer<typeof ReplayNextResponse>;

// ---- Dashboard API: corrections (KB-18, KB-17, UC-16; FEAT-018 §3) --------------------

export const CorrectionSource = z.enum([
  'thumbs_down',
  'staff_reply',
  'staff_edit',
  'coaching',
  'oversight',
  'stale',
  'coverage_gap',
]);
export type CorrectionSource = z.infer<typeof CorrectionSource>;
/** Each fact a correction refers to, as it is now. */
export const CorrectionFact = z.object({
  id: z.uuid(),
  label: z.string(),
  type: FactType,
  status: z.union([FactStatus, z.literal('deleted')]),
  version: z.int().min(0),
  lastConfirmedAt: z.iso.datetime({ offset: true }).nullable(),
  overdue: z.boolean(),
});
export type CorrectionFact = z.infer<typeof CorrectionFact>;
export const GapReason = z.enum(['unavailable', 'unsure', 'escalated']);
export type GapReason = z.infer<typeof GapReason>;
export const GapQuestion = z.object({
  messageId: z.uuid(),
  conversationId: z.uuid(),
  body: z.string(),
  askedAt: z.iso.datetime({ offset: true }),
  reason: GapReason,
});
export type GapQuestion = z.infer<typeof GapQuestion>;
export const CorrectionItem = z.object({
  id: z.uuid(),
  status: CorrectionStatus,
  source: CorrectionSource,
  proposedBy: z.enum(['system', 'coaching', 'staff']),
  change: ProposedChange,
  /** What was accepted when the fix was edited (D7). */
  acceptedChange: ProposedChange.nullable(),
  facts: z.array(CorrectionFact),
  coachingSessionId: z.uuid().nullable(),
  conversationId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  /** A stale item the scan closed because its fact moved on (D8). */
  closedBySystem: z.boolean(),
  /** A coverage gap's newest ask (masked) and count, for the list row (FEAT-019). */
  gap: z.object({ question: z.string(), asksTotal: z.int().min(0) }).nullish(),
});
export type CorrectionItem = z.infer<typeof CorrectionItem>;
export const CorrectionContext = z.object({
  coaching: z.object({ question: z.string().nullable(), proposal: z.string() }).nullable(),
  /** The last 6 messages up to the item's creation, masked. */
  conversation: z.array(OriginalReply.extend({ author: MessageAuthor })).nullable(),
  /** A coverage gap's counts and newest asked questions, masked (FEAT-019 §3). */
  gap: z
    .object({
      asks30d: z.int().min(0),
      asksTotal: z.int().min(0),
      lastAskedAt: z.iso.datetime({ offset: true }).nullable(),
      questions: z.array(GapQuestion).max(5),
    })
    .nullable(),
});
export type CorrectionContext = z.infer<typeof CorrectionContext>;
export const CorrectionEdit = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit_fact'), after: FactValueView }),
  z.object({
    kind: z.literal('add_faq'),
    question: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(2000),
  }),
]);
export type CorrectionEdit = z.infer<typeof CorrectionEdit>;
export const CorrectionReplayTurn = z
  .object({
    messageId: z.uuid(),
    conversationId: z.uuid(),
    index: z.int().min(0),
    question: z.string(),
    askedAt: z.iso.datetime({ offset: true }),
    original: z.array(OriginalReply),
    status: z.enum(['pending', 'done']),
    replayed: CoachMessage.nullable(),
    effects: z.array(ReplayEffect),
    /** The replayed text differs from the first original agent reply's; null while pending. */
    answerChanged: z.boolean().nullable(),
  })
  .refine((t) => (t.status === 'done') === (t.replayed !== null), {
    message: 'a done turn has its replayed answer, a pending one none',
    path: ['replayed'],
  });
export type CorrectionReplayTurn = z.infer<typeof CorrectionReplayTurn>;
export const CorrectionReplay = z.object({
  status: z.enum(['replaying', 'complete']),
  /** All past questions that used the corrected facts; at most 20 replay (D4). */
  matched: z.int().min(0),
  turns: z.array(CorrectionReplayTurn).max(REPLAY_LIMIT),
});
export type CorrectionReplay = z.infer<typeof CorrectionReplay>;
export const CorrectionListQuery = z.object({
  status: z.enum(['open', 'closed']).default('open'),
  source: CorrectionSource.optional(),
  cursor: z.string().min(1).max(200).optional(),
});
export type CorrectionListQuery = z.infer<typeof CorrectionListQuery>;
export const CorrectionList = z.object({
  corrections: z.array(CorrectionItem),
  nextCursor: z.string().nullable(),
});
export type CorrectionList = z.infer<typeof CorrectionList>;
export const CorrectionDetail = z.object({
  correction: CorrectionItem,
  context: CorrectionContext,
  replay: CorrectionReplay.nullable(),
});
export type CorrectionDetail = z.infer<typeof CorrectionDetail>;
export const CorrectionAccept = z.object({ edit: CorrectionEdit.nullable() }).strict();
export type CorrectionAccept = z.infer<typeof CorrectionAccept>;
export const CorrectionAcceptResponse = z.object({
  correction: CorrectionItem,
  replay: CorrectionReplay.nullable(),
});
export type CorrectionAcceptResponse = z.infer<typeof CorrectionAcceptResponse>;
export const CorrectionItemResponse = z.object({ correction: CorrectionItem });
export const CorrectionReplayNextResponse = z.object({
  turn: CorrectionReplayTurn,
  remaining: z.int().min(0),
});
export type CorrectionReplayNextResponse = z.infer<typeof CorrectionReplayNextResponse>;
const ReviewMonths = z.int().min(1).max(24);
/** Months before an approved fact of each type is due for re-confirmation (KB-17, D6). */
export const ReviewIntervals = z
  .object({
    product: ReviewMonths,
    faq: ReviewMonths,
    policy: ReviewMonths,
    promotion: ReviewMonths,
  })
  .strict();
export type ReviewIntervals = z.infer<typeof ReviewIntervals>;
export const DEFAULT_REVIEW_INTERVALS: ReviewIntervals = {
  product: 6,
  faq: 6,
  policy: 6,
  promotion: 6,
};
export const ReviewIntervalsBody = z.object({ intervals: ReviewIntervals }).strict();
export const ReviewIntervalsResponse = z.object({ intervals: ReviewIntervals });

// ---- Dashboard API: coverage (KB-09, UC-16 3b; FEAT-019 §3) ----------------------------

export const CoverageTopicState = z.enum(['covered', 'missing', 'skipped']);
export type CoverageTopicState = z.infer<typeof CoverageTopicState>;
export const CoverageTopic = z
  .object({
    id: z.string(),
    question: z.string(),
    hint: z.string(),
    state: CoverageTopicState,
    /** The approved fact that answers the topic; null unless covered. */
    coveredBy: z.object({ factId: z.uuid(), type: FactType, label: z.string() }).nullable(),
  })
  .refine((t) => (t.state === 'covered') === (t.coveredBy !== null), {
    message: 'a covered topic names its fact, and only a covered one',
    path: ['coveredBy'],
  });
export type CoverageTopic = z.infer<typeof CoverageTopic>;
export const CoverageGap = z.object({
  correctionId: z.uuid(),
  /** The newest ask, masked. */
  question: z.string(),
  asks30d: z.int().min(0),
  asksTotal: z.int().min(1),
  firstAskedAt: z.iso.datetime({ offset: true }),
  lastAskedAt: z.iso.datetime({ offset: true }),
  reasons: z.array(GapReason).min(1),
});
export type CoverageGap = z.infer<typeof CoverageGap>;
/** Top gaps shown on Coverage (D6); the queue holds every open item. */
export const COVERAGE_GAP_LIMIT = 20;
export const CoverageReport = z.object({
  /** `live` once the tenant has a conversation, until FEAT-034's channel-live flag (D4). */
  stage: z.enum(['pre_live', 'live']),
  template: z
    .object({
      industry: Industry,
      topics: z.array(CoverageTopic),
      /** `question_only` when the topics couldn't be embedded: key matching only (D7). */
      checked: z.enum(['meaning', 'question_only']),
    })
    .nullable(),
  gaps: z.array(CoverageGap).max(COVERAGE_GAP_LIMIT),
  summary: z.object({
    topicsTotal: z.int().min(0),
    topicsMissing: z.int().min(0),
    openGaps: z.int().min(0),
  }),
});
export type CoverageReport = z.infer<typeof CoverageReport>;
export const CoverageTopicBody = z.object({ skipped: z.boolean() }).strict();
export type CoverageTopicBody = z.infer<typeof CoverageTopicBody>;
export const CoverageTopicResponse = z.object({ topic: CoverageTopic });
export type CoverageTopicResponse = z.infer<typeof CoverageTopicResponse>;

// ---- Dashboard API: website widget (ONB-07, CHN-11, CHN-14; FEAT-032 §3) -------------

export const WIDGET_ORIGIN_LIMIT = 20;
export const WIDGET_LOGO_MAX_BYTES = 102_400;
export const WIDGET_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AllowedOrigin = z.object({
  origin: z.string(),
  /** A confirmed website source's host (FEAT-012). */
  fromWebsite: z.boolean(),
});
export type AllowedOrigin = z.infer<typeof AllowedOrigin>;
export const InstallState = z.enum(['waiting', 'detected', 'wrong_domain']);
export type InstallState = z.infer<typeof InstallState>;
export const InstallCheck = z.object({
  state: InstallState,
  /** First load on an allowed origin. */
  origin: z.string().nullable(),
  seenAt: z.iso.datetime({ offset: true }).nullable(),
  lastSeenAt: z.iso.datetime({ offset: true }).nullable(),
  /** Latest load on an unlisted origin (UC-05 5a). */
  rejectedOrigin: z.string().nullable(),
  rejectedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type InstallCheck = z.infer<typeof InstallCheck>;
export const DetectStatus = z.enum(['none', 'queued', 'running', 'done', 'failed']);
export const DetectFailure = z.enum(['unreachable', 'blocked', 'timeout', 'no_page']);
export type DetectFailure = z.infer<typeof DetectFailure>;
export const Detection = z.object({
  status: DetectStatus,
  failure: DetectFailure.nullable(),
  requestedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Detection = z.infer<typeof Detection>;
export const WidgetSettings = z.object({
  widgetKey: z.string(),
  /** The one-line `<script>` tag to paste. */
  snippet: z.string(),
  theme: WidgetTheme,
  detection: Detection,
  siteUrl: z.string().nullable(),
  allowedOrigins: z.array(AllowedOrigin),
  install: InstallCheck,
  /** The widget's preview page, shown in an iframe (D6). */
  previewUrl: z.url(),
});
export type WidgetSettings = z.infer<typeof WidgetSettings>;
export const WidgetAppearanceBody = z
  .object({ position: WidgetPosition, overrides: ThemeOverrides })
  .strict();
export type WidgetAppearanceBody = z.infer<typeof WidgetAppearanceBody>;
export const WidgetDetectBody = z.object({ origin: z.string().max(300).optional() }).strict();
export type WidgetDetectBody = z.infer<typeof WidgetDetectBody>;
export const WidgetDetectResponse = z.object({ detection: Detection });
export type WidgetDetectResponse = z.infer<typeof WidgetDetectResponse>;
export const WidgetOriginBody = z.object({ origin: z.string().trim().min(1).max(300) }).strict();
export type WidgetOriginBody = z.infer<typeof WidgetOriginBody>;

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
/** The kill switch changed (FEAT-057 §3): a nudge to refetch `GET /api/v1/ai/status`. */
export const AiStatusEvent = z.object({ type: z.literal('ai_status'), paused: z.boolean() });
export type AiStatusEvent = z.infer<typeof AiStatusEvent>;
export const RealtimeEvent = z.discriminatedUnion('type', [
  MessageEvent,
  ConversationEvent,
  SegmentEvent,
  AiStatusEvent,
]);
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;
/**
 * A member's role changed or they were deactivated (FEAT-007 D5), on `channels.member`, or
 * a session was signed out (FEAT-008), on `channels.session`: the realtime role closes the
 * matching sockets with 4401. Never sent to clients.
 */
export const SessionEndedEvent = z.object({ type: z.literal('session_ended') });
export type SessionEndedEvent = z.infer<typeof SessionEndedEvent>;

// ---- Queue payloads (outbox → SQS; ADR-012) --------------------------------------

export const TurnJob = z.object({
  tenantId: z.uuid(),
  conversationId: z.uuid(),
  messageId: z.uuid(),
});
export type TurnJob = z.infer<typeof TurnJob>;

/**
 * One stage of a source's ingestion run (ADR-018 decision 1; FEAT-012 §5.1), or the purge
 * of a deleted file's objects (FEAT-015 §5.7).
 */
export const IngestJob = z.union([
  z.object({
    tenantId: z.uuid(),
    sourceId: z.uuid(),
    attempt: z.number().int().min(1),
    stage: z.enum(['scan', 'parse', 'import', 'crawl', 'extract', 'promote']),
  }),
  z.object({
    tenantId: z.uuid(),
    sourceId: z.uuid(),
    stage: z.literal('purge'),
    keys: z.object({ quarantine: z.string().optional(), sources: z.string().optional() }),
  }),
]);
export type IngestJob = z.infer<typeof IngestJob>;

/** The ingest-worker's theme detection for a tenant's site (FEAT-032 §5.4, D4). */
export const ThemeDetectJob = z.object({
  kind: z.literal('theme_detect'),
  tenantId: z.uuid(),
  url: z.url(),
  /** Matches `widget_settings.detect_requested_at`; an older job is a stale redelivery. */
  requestedAt: z.iso.datetime({ offset: true }),
});
export type ThemeDetectJob = z.infer<typeof ThemeDetectJob>;

// ---- Dashboard API: privacy (GOV-14, GOV-07, GOV-11, LED-02; FEAT-058 §3)

export const LocalTextIn = z.object({
  en: z.string().trim().min(1).max(600),
  zh: z.string().trim().max(600).nullable(),
});

export const NoticeTemplateFields = z.object({
  /** The data protection officer or contact person. */
  contactName: z.string().trim().min(1).max(120),
  contactEmail: z.email().max(254),
  contactPhone: z.string().trim().max(40).nullable(),
  address: z.string().trim().max(300).nullable(),
  /** "Anything else to tell visitors": plain paragraphs, no markup. */
  extra: z.string().trim().max(2000).nullable(),
});
export type NoticeTemplateFields = z.infer<typeof NoticeTemplateFields>;

export const PrivacyNoticeBody = z.discriminatedUnion('mode', [
  z.object({
    version: z.number().int().min(0),
    mode: z.literal('link'),
    url: z.url({ protocol: /^https$/ }).max(2048),
  }),
  z.object({
    version: z.number().int().min(0),
    mode: z.literal('template'),
    fields: NoticeTemplateFields,
  }),
]);
export type PrivacyNoticeBody = z.infer<typeof PrivacyNoticeBody>;

export const PurposeStatementBody = z.object({
  version: z.number().int().min(0),
  purpose: LocalTextIn,
});
export type PurposeStatementBody = z.infer<typeof PurposeStatementBody>;

const WordingRef = z.object({ seq: z.number().int().min(1), savedAt: z.iso.datetime() });

export const PrivacyDocuments = z.object({
  /** The registry date, YYYY-MM-DD. */
  updatedOn: z.string(),
  dpaVersion: z.string(),
  subProcessors: z.array(
    z.object({
      name: z.string(),
      service: z.string(),
      purpose: z.string(),
      location: z.string(),
      dataAtRest: z.boolean(),
    }),
  ),
  transfers: z.array(
    z.object({
      data: z.string(),
      from: z.string(),
      to: z.string(),
      purpose: z.string(),
      safeguard: z.string(),
      retention: z.string(),
    }),
  ),
});
export type PrivacyDocuments = z.infer<typeof PrivacyDocuments>;

export const PrivacySettingsResponse = z.object({
  /** privacy_settings.version; 0 = never saved. */
  version: z.number().int().min(0),
  notice: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({ mode: z.literal('link'), url: z.url(), wording: WordingRef }),
    z.object({
      mode: z.literal('template'),
      fields: NoticeTemplateFields,
      templateVersion: z.string(),
      publicUrl: z.url(),
      wording: WordingRef,
    }),
  ]),
  /** `wording` null = the default, not yet saved (D6). */
  purpose: z.object({
    text: z.object({ en: z.string(), zh: z.string().nullable() }),
    wording: WordingRef.nullable(),
  }),
  defaults: z.object({
    purpose: z.object({ en: z.string(), zh: z.string() }),
    template: z.object({
      organisationName: z.string(),
      uen: z.string().nullable(),
      contactEmail: z.string().nullable(),
    }),
  }),
  readiness: z.object({ privacyNotice: z.boolean(), purposeStatement: z.boolean() }),
  documents: PrivacyDocuments,
  terms: z.array(
    z.object({
      document: z.enum(['tos', 'aup', 'dpa']),
      title: z.string(),
      currentVersion: z.string(),
      acceptedVersion: z.string().nullable(),
      acceptedAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type PrivacySettingsResponse = z.infer<typeof PrivacySettingsResponse>;

// ---- Dashboard API: channels (ONB-10, CHN-12; FEAT-034 §3) ------------------------

export const ChannelKind = z.enum([
  'widget',
  'email',
  'telegram',
  'messenger',
  'instagram',
  'whatsapp',
]);
export type ChannelKind = z.infer<typeof ChannelKind>;
export const ChannelHealthReason = z.enum([
  'credential_revoked',
  'credential_invalid',
  'unreachable',
  'send_rejected',
]);
export type ChannelHealthReason = z.infer<typeof ChannelHealthReason>;
export const ChannelOfflineMode = z.enum(['hidden', 'message']);
export type ChannelOfflineMode = z.infer<typeof ChannelOfflineMode>;
export const CHANNEL_OFFLINE_TEXT_MAX = 300;
const offlineText = z.string().trim().min(1).max(CHANNEL_OFFLINE_TEXT_MAX).nullable();
export const OfflineText = z.object({ en: offlineText, zh: offlineText });
export type OfflineText = z.infer<typeof OfflineText>;

export const ChannelItem = z.object({
  id: z.uuid(),
  kind: ChannelKind,
  /** From the registry ("Website chat widget"). */
  name: z.string(),
  state: z.enum(['live', 'offline']),
  /** Null: never changed (never live). */
  stateChangedAt: z.iso.datetime().nullable(),
  health: z.enum(['ok', 'degraded', 'unknown']),
  healthReason: ChannelHealthReason.nullable(),
  healthCheckedAt: z.iso.datetime().nullable(),
  degradedSince: z.iso.datetime().nullable(),
  /** Registry: false for the widget. */
  checksHealth: z.boolean(),
  /** Widget: both; others: `['message']`. */
  offlineModes: z.array(ChannelOfflineMode).min(1),
  offline: z.object({
    mode: ChannelOfflineMode,
    message: OfflineText,
    defaults: z.object({ en: z.string(), zh: z.string() }),
  }),
  version: z.number().int().positive(),
});
export type ChannelItem = z.infer<typeof ChannelItem>;

export const ChannelsResponse = z.object({
  channels: z.array(ChannelItem),
  /** Empty until FEAT-036 registers a channel with a connect flow. */
  connectable: z.array(z.object({ kind: ChannelKind, name: z.string(), connectPath: z.string() })),
});
export type ChannelsResponse = z.infer<typeof ChannelsResponse>;

export const ChannelStateBody = z.object({ version: z.number().int().positive() });
export type ChannelStateBody = z.infer<typeof ChannelStateBody>;

export const ChannelOfflineBody = z.object({
  mode: ChannelOfflineMode,
  message: OfflineText,
  version: z.number().int().positive(),
});
export type ChannelOfflineBody = z.infer<typeof ChannelOfflineBody>;

// ---- Dashboard API: kill switch (GOV-08; FEAT-057 §3) ------------------------------

export const AiStatus = z.object({
  paused: z.boolean(),
  /** When the current pause started; null while not paused. */
  pausedAt: z.iso.datetime().nullable(),
  /** Channels in state `live` (FEAT-034). 0 and not paused → the pill says "Not live". */
  liveChannels: z.number().int().min(0),
  /** The fallback visitors get while paused, resolved (tenant wording or the default). */
  fallback: z.object({ en: z.string(), zh: z.string() }),
});
export type AiStatus = z.infer<typeof AiStatus>;
export const AiStatusResponse = z.object({ status: AiStatus });
export type AiStatusResponse = z.infer<typeof AiStatusResponse>;

// ---- Dashboard API: two-step verification and re-auth (AUTH-03; FEAT-006 §3) -------------

export const MfaState = z.enum(['ok', 'challenge', 'enrol']);
export type MfaState = z.infer<typeof MfaState>;

export const MfaStatus = z.object({
  /** `challenge`: pass a code first; `enrol`: a workspace requires two-step (§5.2). */
  state: MfaState,
  enrolled: z.boolean(),
  enrolledAt: z.iso.datetime({ offset: true }).nullable(),
  recoveryCodesLeft: z.number().int().min(0),
  /** The user's workspaces that require two-step verification (removal is refused). */
  requiredBy: z.array(z.object({ tenantId: z.uuid(), name: z.string() })),
  /** Set while five wrong codes lock the code challenge (UC-02 3c). */
  lockedUntil: z.iso.datetime({ offset: true }).nullable(),
  email: z.string(),
});
export type MfaStatus = z.infer<typeof MfaStatus>;

/** A code from the authenticator app (6 digits) or a recovery code (`xxxxx-xxxxx`). */
export const MfaCode = z.object({
  method: z.enum(['totp', 'recovery']),
  code: z.string().trim().min(1).max(32),
});
export type MfaCode = z.infer<typeof MfaCode>;

export const MfaEnrolmentStart = z.object({
  /** Base32, for typing into the app by hand. */
  secret: z.string(),
  otpauthUri: z.string().startsWith('otpauth://totp/'),
});
export type MfaEnrolmentStart = z.infer<typeof MfaEnrolmentStart>;

export const MfaEnrolmentConfirm = z.object({ code: z.string().trim().min(1).max(32) });
export type MfaEnrolmentConfirm = z.infer<typeof MfaEnrolmentConfirm>;

/** Shown once (AUTH-03): ten single-use codes. */
export const RecoveryCodes = z.object({ codes: z.array(z.string()).length(10) });
export type RecoveryCodes = z.infer<typeof RecoveryCodes>;

export const ReauthMethod = z.enum(['totp', 'recovery', 'email']);
export type ReauthMethod = z.infer<typeof ReauthMethod>;

export const ReauthStatus = z.object({
  fresh: z.boolean(),
  /** When the 10-minute window closes; null when it's already closed. */
  until: z.iso.datetime({ offset: true }).nullable(),
  methods: z.array(ReauthMethod),
});
export type ReauthStatus = z.infer<typeof ReauthStatus>;

/**
 * 403 from any sensitive action without a fresh re-authentication (AUTH-03). Later
 * features' tests use this one shape; the dashboard's `reauth-dialog` opens with `methods`.
 */
export const ReauthRequired = z.object({
  error: z.literal('reauth_required'),
  message: z.string(),
  methods: z.array(ReauthMethod).min(1),
});
export type ReauthRequired = z.infer<typeof ReauthRequired>;

export const TeamMfa = z.object({
  required: z.boolean(),
  /** Active members of the session's workspace, and how many have two-step on. */
  members: z.number().int().min(0),
  enrolled: z.number().int().min(0),
});
export type TeamMfa = z.infer<typeof TeamMfa>;

export const TeamMfaBody = z.object({ required: z.boolean() });
export type TeamMfaBody = z.infer<typeof TeamMfaBody>;

// ---- Dashboard API: boundary rules (APR-01; FEAT-054 §3) ---------------------------------

export const COMMITMENT_KEYS = [
  'delivery_guarantee',
  'refund',
  'legal_advice',
  'medical_advice',
] as const;
export const CommitmentKey = z.enum(COMMITMENT_KEYS);
export type CommitmentKey = z.infer<typeof CommitmentKey>;
/** Always forbidden: AGT-13 declines advice in code, so these can't be switched off (D6). */
export const LOCKED_COMMITMENTS = ['legal_advice', 'medical_advice'] as const;

export const BOUNDARY_LIMITS = { topics: 25, customCommitments: 10, topicMin: 2, topicMax: 80 };

/** One topic or phrase. */
const Topic = z.string().trim().min(BOUNDARY_LIMITS.topicMin).max(BOUNDARY_LIMITS.topicMax);

const lower = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export const BoundaryRules = z
  .object({
    allowedTopics: z.array(Topic).max(BOUNDARY_LIMITS.topics),
    blockedTopics: z.array(Topic).max(BOUNDARY_LIMITS.topics),
    maxDiscountPct: z.number().int().min(0).max(100),
    quotesNeedApproval: z.boolean(),
    forbiddenCommitments: z.array(CommitmentKey),
    /** The owner's own, such as "same-day delivery". */
    customCommitments: z.array(Topic).max(BOUNDARY_LIMITS.customCommitments),
  })
  .superRefine((r, ctx) => {
    // No duplicate in a list, ignoring case and spacing.
    for (const field of ['allowedTopics', 'blockedTopics', 'customCommitments'] as const) {
      const seen = new Set<string>();
      r[field].forEach((v, i) => {
        if (seen.has(lower(v)))
          ctx.addIssue({ code: 'custom', path: [field, i], message: 'duplicate' });
        seen.add(lower(v));
      });
    }
    const allowed = new Set(r.allowedTopics.map(lower));
    r.blockedTopics.forEach((v, i) => {
      if (allowed.has(lower(v)))
        ctx.addIssue({ code: 'custom', path: ['blockedTopics', i], message: 'also_allowed' });
    });
    for (const key of LOCKED_COMMITMENTS)
      if (!r.forbiddenCommitments.includes(key))
        ctx.addIssue({ code: 'custom', path: ['forbiddenCommitments'], message: 'locked' });
  });
export type BoundaryRules = z.infer<typeof BoundaryRules>;

export const BoundaryRulesResponse = z.object({
  rules: BoundaryRules,
  /** Null until the first save; a template prefill is shown but only the defaults are in force. */
  version: z.number().int().positive().nullable(),
  savedAt: z.iso.datetime().nullable(),
  /** Where the shown rules come from: the saved version, the industry template, or the safe defaults. */
  source: z.enum(['saved', 'template', 'default']),
});
export type BoundaryRulesResponse = z.infer<typeof BoundaryRulesResponse>;

export const SaveBoundaryRulesRequest = z.object({
  /** The version the form was loaded from (null when never saved): optimistic concurrency. */
  version: z.number().int().positive().nullable(),
  rules: BoundaryRules,
});
export type SaveBoundaryRulesRequest = z.infer<typeof SaveBoundaryRulesRequest>;

// ---- Dashboard API: onboarding and go-live (ONB-02, ONB-09; FEAT-035 §3) ---------------------

/** The wizard's steps, in order. */
export const OnboardingStep = z.enum([
  'profile',
  'sources',
  'review',
  'rules',
  'test',
  'website',
  'go_live',
]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const OnboardingProgress = z.object({
  /** `profile` when never saved. */
  currentStep: OnboardingStep,
  /** Partial: a step that's absent was not started. */
  steps: z.partialRecord(OnboardingStep, z.enum(['done', 'skipped'])),
  /** Null until the first go-live. */
  firstLiveAt: z.iso.datetime().nullable(),
});
export type OnboardingProgress = z.infer<typeof OnboardingProgress>;

export const StepOutcomeBody = z.object({ outcome: z.enum(['visited', 'done', 'skipped']) });
export type StepOutcomeBody = z.infer<typeof StepOutcomeBody>;

/** The go-live check's required items, in the order shown. */
export const ReadinessKey = z.enum([
  'profile',
  'approved_fact',
  'disclosure',
  'purpose',
  'notice',
  'terms',
  'rules',
]);
export type ReadinessKey = z.infer<typeof ReadinessKey>;

export const ReadinessResponse = z.object({
  /** Always all seven, in `ReadinessKey` order. */
  items: z.array(z.object({ key: ReadinessKey, ok: z.boolean() })),
  warnings: z.object({
    conflicts: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
  }),
  /** Every item ok. */
  ready: z.boolean(),
  /** Purpose statement and privacy notice in place (UX-R4). */
  preLiveForm: z.boolean(),
  firstLiveAt: z.iso.datetime().nullable(),
  /** The Channels page's items, registry order. */
  channels: z.array(ChannelItem),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;

export const GoLiveBody = z.object({
  channels: z
    .array(z.object({ id: z.uuid(), version: z.number().int().positive() }))
    .min(1)
    .max(10),
  /** Required when there are warnings (409 `warnings_unacknowledged` otherwise). */
  acknowledgeWarnings: z.boolean(),
});
export type GoLiveBody = z.infer<typeof GoLiveBody>;

/** 409 from Go live (the check or the Channels page) before the first go-live. */
export const NotReady = z.object({
  error: z.literal('not_ready'),
  missing: z.array(ReadinessKey).min(1),
});
export type NotReady = z.infer<typeof NotReady>;

// ---- Dashboard API: team, invitations and workspaces (DSH-03, AUTH-04; FEAT-007 §3) ---------

/** Never `owner`: ownership moves only by transfer (FEAT-010). */
export const InvitableRole = z.enum(['admin', 'agent']);
export type InvitableRole = z.infer<typeof InvitableRole>;

export const TeamMember = z.object({
  userId: z.uuid(),
  email: z.string(),
  /** The member's profile name (FEAT-008); the page falls back to the email. */
  displayName: z.string().nullable(),
  role: Role,
  status: z.enum(['active', 'deactivated']),
  /** Only ever true for an agent. */
  approvalRights: z.boolean(),
  mfaEnrolled: z.boolean(),
  joinedAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime().nullable(),
  you: z.boolean(),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const TeamInvitation = z.object({
  id: z.uuid(),
  email: z.string(),
  role: InvitableRole,
  /** The inviter's email. */
  invitedBy: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  state: z.enum(['pending', 'expired']),
  delivery: z.enum(['sent', 'queued']),
});
export type TeamInvitation = z.infer<typeof TeamInvitation>;

export const TeamResponse = z.object({
  members: z.array(TeamMember),
  invitations: z.array(TeamInvitation),
});
export type TeamResponse = z.infer<typeof TeamResponse>;

export const InviteBody = z.object({ email: MagicLinkRequest.shape.email, role: InvitableRole });
export type InviteBody = z.infer<typeof InviteBody>;

/** Exactly one change per request. */
export const MemberPatch = z.union([
  z.object({ role: InvitableRole }).strict(),
  z.object({ status: z.enum(['active', 'deactivated']) }).strict(),
  z.object({ approvalRights: z.boolean() }).strict(),
]);
export type MemberPatch = z.infer<typeof MemberPatch>;

export const InvitationTokenBody = MagicLinkVerifyBody;
export type InvitationTokenBody = z.infer<typeof InvitationTokenBody>;

export const InvitationLookup = z.object({
  state: z.enum(['valid', 'expired', 'used', 'revoked']),
  tenantName: z.string(),
  role: InvitableRole,
  email: z.string(),
  invitedBy: z.string(),
  /** The signed-in user's email, if the request carried a session. */
  signedInAs: z.string().nullable(),
});
export type InvitationLookup = z.infer<typeof InvitationLookup>;

export const Workspace = z.object({
  id: z.uuid(),
  name: z.string(),
  role: Role,
  current: z.boolean(),
});
export type Workspace = z.infer<typeof Workspace>;
export const WorkspaceList = z.object({ workspaces: z.array(Workspace) });
export type WorkspaceList = z.infer<typeof WorkspaceList>;

// ---- Dashboard API: my account (AUTH-05, AUTH-02; FEAT-008 §3) -------------------------

// Tabs, newlines and other control characters would break the menu and the team list.
// eslint-disable-next-line no-control-regex
const noControlChars = (s: string) => !/[\u0000-\u001f\u007f-\u009f]/.test(s);

/** The profile name shown to the team and, from FEAT-042, visitors. */
export const DisplayName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(noControlChars, { message: 'Use letters, numbers and punctuation only' });

export const Account = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  googleLinked: z.boolean(),
  /** A requested change not yet confirmed; `queued` while its emails wait for a retry. */
  pendingEmail: z
    .object({
      email: z.string(),
      requestedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      delivery: z.enum(['sent', 'queued']),
    })
    .nullable(),
});
export type Account = z.infer<typeof Account>;

/** `null` clears the name. */
export const ProfilePatch = z.object({ displayName: DisplayName.nullable() }).strict();
export type ProfilePatch = z.infer<typeof ProfilePatch>;

export const EmailChangeBody = z.object({ email: MagicLinkRequest.shape.email });
export type EmailChangeBody = z.infer<typeof EmailChangeBody>;

/** The answer to `/email-change/confirm` (its body is `MagicLinkVerifyBody`). */
export const EmailChangeConfirmed = z.object({ email: z.string() });
export type EmailChangeConfirmed = z.infer<typeof EmailChangeConfirmed>;

export const DeviceSession = z.object({
  id: z.uuid(),
  /** "Chrome on Windows", "Safari on iPhone" or "Unknown device" (D6). */
  device: z.string(),
  authMethod: z.enum(['magic_link', 'google']),
  signedInAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

/** Live sessions only, this device first, then by last activity. */
export const DeviceSessionList = z.object({ sessions: z.array(DeviceSession) });
export type DeviceSessionList = z.infer<typeof DeviceSessionList>;
