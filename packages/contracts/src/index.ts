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
