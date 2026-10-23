import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Walking-skeleton schema (FEAT-001). Every tenant-scoped table has `tenant_id`
 * leading its primary key and indexes, with forced RLS added in migration 0001
 * (ADR-005). Later features add their tables through detailed design.
 */

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    // Stub: widget install settings move to the channels module in FEAT-032.
    widgetKey: text('widget_key').notNull().unique(),
    allowedOrigins: text('allowed_origins')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Kill switch (architecture §6.5, ADR-013): read by the send gate via `visitor_tenant_state()`. */
    aiPaused: boolean('ai_paused').notNull().default(false),
    /**
     * Reply routing policy (ADR-007 decision 1, FEAT-004 D10): operator settings, read by
     * the visitor zone through `visitor_tenant_state()`. The cost governor moves the step.
     */
    routeComplexityThreshold: real('route_complexity_threshold').notNull().default(0.6),
    routeMinConfidence: real('route_min_confidence').notNull().default(0.5),
    costGovernorStep: smallint('cost_governor_step').notNull().default(0),
    costGovernorChangedAt: timestamp('cost_governor_changed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'tenants_route_complexity_threshold_ck',
      sql`${t.routeComplexityThreshold} between 0 and 1`,
    ),
    check('tenants_route_min_confidence_ck', sql`${t.routeMinConfidence} between 0 and 1`),
    check('tenants_cost_governor_step_ck', sql`${t.costGovernorStep} between 0 and 3`),
  ],
);

/**
 * Business profile (ONB-03). FEAT-022 needs only the GST flag (KB-15) and FEAT-023 the
 * opening hours (AGT-09); FEAT-009 adds the rest of the profile and its editor.
 */
export const businessProfiles = pgTable(
  'business_profiles',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    gstRegistered: boolean('gst_registered').notNull().default(false),
    /**
     * Weekly opening hours in SGT, `{ mon: [{ open: '08:00', close: '19:00' }], …, sun: [] }`
     * (FEAT-023 §4; `WeeklyHours` in @kaki/tenancy). Null: not set, so no after-hours behaviour.
     */
    hours: jsonb('hours'),
    /** False: closed on SG public holidays (SRS §1.4 "Business hours"). */
    openOnPublicHolidays: boolean('open_on_public_holidays').notNull().default(false),
    /** Optimistic concurrency for the profile screen (FEAT-009 D7). */
    version: integer('version').notNull().default(1),
    /** ACRA UEN, upper case (FEAT-009 D2). */
    uen: text('uen'),
    industry: text('industry'),
    contactEmail: text('contact_email'),
    /** `+65XXXXXXXX` (FEAT-009 D3). */
    contactPhone: text('contact_phone'),
    /** Default languages (ONB-03); stored, not yet read by the agent (FEAT-009 D6). */
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{en}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'business_profiles_hours_ck',
      sql`${t.hours} is null or jsonb_typeof(${t.hours}) = 'object'`,
    ),
    check(
      'business_profiles_uen_ck',
      sql`${t.uen} is null or ${t.uen} ~ '^([0-9]{8}[A-Z]|(18|19|20)[0-9]{7}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$'`,
    ),
    check(
      'business_profiles_industry_ck',
      sql`${t.industry} is null or ${t.industry} in ('fnb', 'retail', 'beauty_wellness', 'education', 'professional_services', 'home_services', 'other')`,
    ),
    check(
      'business_profiles_phone_ck',
      sql`${t.contactPhone} is null or ${t.contactPhone} ~ '^[+]65[3689][0-9]{7}$'`,
    ),
    check(
      'business_profiles_email_ck',
      sql`${t.contactEmail} is null or (char_length(${t.contactEmail}) <= 254 and ${t.contactEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+$')`,
    ),
    check(
      'business_profiles_languages_ck',
      sql`cardinality(${t.languages}) between 1 and 4 and ${t.languages} <@ '{en,zh,ms,ta}'::text[]`,
    ),
  ],
);

/**
 * The tenant's exceptions to the SG public-holiday calendar and its own closures
 * (ONB-03; FEAT-009 §4, D4): `open` = usual hours on a public holiday, `closed` = closed
 * all day. The calendar itself is code data in @kaki/tenancy (FEAT-023 D3).
 */
export const holidays = pgTable(
  'holidays',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    day: date('day', { mode: 'string' }).notNull(),
    kind: text('kind', { enum: ['open', 'closed'] }).notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day] }),
    check('holidays_kind_ck', sql`${t.kind} in ('open', 'closed')`),
    check(
      'holidays_label_ck',
      sql`${t.label} is null or (btrim(${t.label}) <> '' and char_length(${t.label}) <= 60)`,
    ),
  ],
);

/** Assistant tones (AGT-08; FEAT-024 §4). */
export const ASSISTANT_TONES = ['friendly', 'professional'] as const;

/** A tenant text: null (the default) or non-blank and at most `max` characters. */
const tenantText = (column: unknown, max: number) =>
  sql`(${column} is null or (btrim(${column}) <> '' and char_length(${column}) <= ${sql.raw(String(max))}))`;

/**
 * Assistant persona and messages (AGT-08, AGT-11; FEAT-024 §4, D1): one row per tenant,
 * absent until the first save (defaults). Texts are per language, null = the default
 * (D3). The visitor zone reads it only through `visitor_tenant_state()`.
 */
export const assistantSettings = pgTable(
  'assistant_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    version: integer('version').notNull().default(1),
    botName: text('bot_name'),
    tone: text('tone', { enum: ASSISTANT_TONES }).notNull().default('friendly'),
    emoji: boolean('emoji').notNull().default(false),
    greetingEn: text('greeting_en'),
    greetingZh: text('greeting_zh'),
    disclosureNoteEn: text('disclosure_note_en'),
    disclosureNoteZh: text('disclosure_note_zh'),
    afterHoursEn: text('after_hours_en'),
    afterHoursZh: text('after_hours_zh'),
    fallbackEn: text('fallback_en'),
    fallbackZh: text('fallback_zh'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('assistant_settings_tone_ck', sql`${t.tone} in ('friendly', 'professional')`),
    // D6: no digits, because the verifier blocks every number the model types.
    check(
      'assistant_settings_bot_name_ck',
      sql`${t.botName} is null or (char_length(${t.botName}) between 1 and 30 and ${t.botName} !~ '[0-9]' and btrim(${t.botName}) = ${t.botName})`,
    ),
    check(
      'assistant_settings_texts_ck',
      sql`${tenantText(t.greetingEn, 200)} and ${tenantText(t.greetingZh, 200)} and ${tenantText(t.disclosureNoteEn, 200)} and ${tenantText(t.disclosureNoteZh, 200)} and ${tenantText(t.afterHoursEn, 300)} and ${tenantText(t.afterHoursZh, 300)} and ${tenantText(t.fallbackEn, 300)} and ${tenantText(t.fallbackZh, 300)}`,
    ),
  ],
);

/** System notice kinds on a message (FEAT-023 §4); later kinds extend `messages_notice_ck`. */
export const NOTICE_KINDS = ['after_hours', 'chat_ended'] as const;
/** Why a conversation is flagged for staff (AGT-13, FEAT-025 §4); the inbox filters on it (FEAT-042). */
export const FLAG_REASONS = ['abuse', 'crisis'] as const;

export const conversations = pgTable(
  'conversations',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    channel: text('channel', { enum: ['widget'] }).notNull(),
    visitorId: uuid('visitor_id').notNull(),
    status: text('status', { enum: ['ai', 'human', 'closed'] })
      .notNull()
      .default('ai'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the conversation was first flagged for staff (AGT-13). */
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    /** Why, distinct and in the order flagged. */
    flagReasons: text('flag_reasons', { enum: FLAG_REASONS })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The visitor messages triage tagged as abuse: counting turns keeps redelivery idempotent. */
    abuseTurns: uuid('abuse_turns')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('conversations_tenant_last_message_idx').on(t.tenantId, t.lastMessageAt.desc()),
    index('conversations_tenant_flagged_idx')
      .on(t.tenantId, t.flaggedAt.desc())
      .where(sql`${t.flaggedAt} is not null`),
    check(
      'conversations_flag_ck',
      sql`${t.flagReasons} <@ array['abuse', 'crisis']::text[] and (${t.flaggedAt} is null) = (cardinality(${t.flagReasons}) = 0)`,
    ),
    check('conversations_abuse_turns_ck', sql`cardinality(${t.abuseTurns}) <= 20`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    conversationId: uuid('conversation_id').notNull(),
    /** Global, monotonically increasing: the SSE `Last-Event-ID` and resume cursor (ADR-017). */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    author: text('author', { enum: ['visitor', 'agent', 'staff', 'system'] }).notNull(),
    body: text('body').notNull(),
    /** Client-generated ID so a retried POST never creates a duplicate message. */
    clientMessageId: text('client_message_id'),
    /** The visitor message an agent reply answers: makes turn processing idempotent. */
    inReplyTo: uuid('in_reply_to'),
    /** The facts the reply's slots rendered (AGT-01). */
    factIds: uuid('fact_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** The AI disclosure, on the first agent or system message of a conversation (AGT-11). */
    disclosure: text('disclosure'),
    /** A system notice shown with the message, server-rendered (AGT-09 after hours, FEAT-023 D6). */
    notice: text('notice'),
    noticeKind: text('notice_kind', { enum: NOTICE_KINDS }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    index('messages_tenant_conversation_seq_idx').on(t.tenantId, t.conversationId, t.seq),
    uniqueIndex('messages_client_message_id_uq').on(
      t.tenantId,
      t.conversationId,
      t.clientMessageId,
    ),
    uniqueIndex('messages_in_reply_to_uq').on(t.tenantId, t.inReplyTo),
    check(
      'messages_notice_ck',
      sql`(${t.notice} is null) = (${t.noticeKind} is null) and (${t.noticeKind} is null or ${t.noticeKind} in ('after_hours', 'chat_ended'))`,
    ),
  ],
);

export const SOURCE_KINDS = ['website', 'file'] as const;
export const SOURCE_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const;
export const SOURCE_STAGES = ['scan', 'parse', 'crawl', 'extract', 'promote'] as const;
export const SOURCE_FAILURES = [
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
] as const;
/** What a file's bytes are (FEAT-015 §5.3), whatever its name says. */
export const FILE_TYPES = ['pdf', 'docx', 'pptx', 'txt', 'jpeg', 'png'] as const;
export const PAGE_STATUSES = ['included', 'excluded', 'failed', 'skipped'] as const;
export const PAGE_REASONS = [
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
] as const;

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * Knowledge sources (KB_SOURCE, ADR-018 decision 1): one row per website (FEAT-012) or
 * uploaded file (FEAT-015); spreadsheets and chat exports join with FEAT-016..017.
 * `attempt` keys the idempotent stage jobs; `version` is the dashboard's
 * optimistic-concurrency token.
 */
export const kbSources = pgTable(
  'kb_sources',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    kind: text('kind', { enum: SOURCE_KINDS }).notNull(),
    status: text('status', { enum: SOURCE_STATUSES }).notNull().default('queued'),
    stage: text('stage', { enum: SOURCE_STAGES }),
    attempt: integer('attempt').notNull().default(1),
    version: integer('version').notNull().default(1),
    /** The domain for a website, the file's name as uploaded for a file. */
    name: text('name').notNull(),
    // Websites only (`kb_sources_website_ck`).
    url: text('url'),
    domain: text('domain'),
    subdomains: text('subdomains')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    pageLimit: integer('page_limit'),
    failure: text('failure', { enum: SOURCE_FAILURES }),
    pagesFound: integer('pages_found').notNull().default(0),
    pagesIncluded: integer('pages_included').notNull().default(0),
    pagesExcluded: integer('pages_excluded').notNull().default(0),
    pagesFailed: integer('pages_failed').notNull().default(0),
    pagesSkipped: integer('pages_skipped').notNull().default(0),
    pagesExtracted: integer('pages_extracted').notNull().default(0),
    factsCount: integer('facts_count').notNull().default(0),
    /** KB-13: who confirmed they own or may use the domain, and when (also audited). */
    attestedBy: text('attested_by'),
    attestedAt: timestamp('attested_at', { withTimezone: true }),
    /**
     * Files (FEAT-015 §4): the quarantine key it was uploaded to, the `sources` bucket key
     * once it passed the safety checks, its size, the type its bytes showed, and how many
     * of its pages were read by OCR.
     */
    uploadKey: text('upload_key'),
    fileKey: text('file_key'),
    fileSize: integer('file_size'),
    fileType: text('file_type', { enum: FILE_TYPES }),
    ocrPages: integer('ocr_pages').notNull().default(0),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('kb_sources_domain_uq').on(t.tenantId, t.kind, t.domain),
    uniqueIndex('kb_sources_upload_uq').on(t.tenantId, t.uploadKey),
    check(
      'kb_sources_website_ck',
      sql`${t.kind} <> 'website' or (${t.url} is not null and ${t.domain} is not null and ${t.pageLimit} is not null and ${t.attestedBy} is not null and ${t.attestedAt} is not null)`,
    ),
    check(
      'kb_sources_file_ck',
      sql`${t.kind} <> 'file' or (${t.uploadKey} is not null and ${t.fileSize} > 0)`,
    ),
    check(
      'kb_sources_file_type_ck',
      sql`${t.fileType} is null or ${t.fileType} in (${inList(FILE_TYPES)})`,
    ),
    check('kb_sources_kind_ck', sql`${t.kind} in (${inList(SOURCE_KINDS)})`),
    check('kb_sources_status_ck', sql`${t.status} in (${inList(SOURCE_STATUSES)})`),
    check(
      'kb_sources_stage_ck',
      sql`${t.stage} is null or ${t.stage} in (${inList(SOURCE_STAGES)})`,
    ),
    check(
      'kb_sources_failure_ck',
      sql`(${t.status} = 'failed') = (${t.failure} is not null) and (${t.failure} is null or ${t.failure} in (${inList(SOURCE_FAILURES)}))`,
    ),
    check(
      'kb_sources_counts_ck',
      sql`(${t.pageLimit} is null or ${t.pageLimit} > 0) and ${t.attempt} >= 1 and least(${t.pagesFound}, ${t.pagesIncluded}, ${t.pagesExcluded}, ${t.pagesFailed}, ${t.pagesSkipped}, ${t.pagesExtracted}, ${t.factsCount}, ${t.ocrPages}) >= 0`,
    ),
  ],
);

/**
 * A crawl's page list (KB-01) or a file's pages, slides or parts (KB-02, FEAT-015), per
 * attempt. `content` is masked visible text (ADR-015). A file page's `url` is a locator,
 * `page/3`, `slide/2`, `part/1` or `image/1`.
 */
export const kbSourcePages = pgTable(
  'kb_source_pages',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    sourceId: uuid('source_id').notNull(),
    attempt: integer('attempt').notNull(),
    seq: integer('seq').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    status: text('status', { enum: PAGE_STATUSES }).notNull(),
    reason: text('reason', { enum: PAGE_REASONS }),
    httpStatus: smallint('http_status'),
    content: text('content'),
    /** SHA-256 of `content`, for duplicates now and the re-crawl diff (FEAT-020). */
    contentHash: text('content_hash'),
    /** 0..1 when the page's text came from OCR (FEAT-015 D6); null for a text layer. */
    ocrConfidence: real('ocr_confidence'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    factsCount: integer('facts_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('kb_source_pages_url_uq').on(t.tenantId, t.sourceId, t.attempt, t.url),
    index('kb_source_pages_seq_idx').on(t.tenantId, t.sourceId, t.attempt, t.seq),
    foreignKey({
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [kbSources.tenantId, kbSources.id],
    }),
    check('kb_source_pages_status_ck', sql`${t.status} in (${inList(PAGE_STATUSES)})`),
    check(
      'kb_source_pages_reason_ck',
      sql`(${t.status} = 'included') = (${t.reason} is null) and (${t.reason} is null or ${t.reason} in (${inList(PAGE_REASONS)}))`,
    ),
    check(
      'kb_source_pages_ocr_ck',
      sql`${t.ocrConfidence} is null or ${t.ocrConfidence} between 0 and 1`,
    ),
  ],
);

export const FACT_TYPES = ['product', 'faq', 'policy', 'promotion'] as const;
export const FACT_STATUSES = [
  'needs_review',
  'approved',
  'rejected',
  'conflicted',
  'disabled',
] as const;
export const GST_TREATMENTS = ['inclusive', 'exclusive', 'unknown'] as const;

/**
 * Facts (ADR-010): one row per fact with its current version and status. Visitors
 * reach facts only through the `visitor_facts` view (migration 0003).
 */
export const facts = pgTable(
  'facts',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    type: text('type', { enum: FACT_TYPES }).notNull(),
    status: text('status', { enum: FACT_STATUSES }).notNull().default('needs_review'),
    /**
     * product: { name, priceCents, currency: 'SGD', unit? }; faq: { question, answer };
     * policy: { kind, title, details }; promotion: { title, details, priceCents?, currency? }.
     */
    value: jsonb('value').notNull(),
    gstTreatment: text('gst_treatment', { enum: GST_TREATMENTS }),
    source: text('source').notNull().default('manual'),
    version: integer('version').notNull().default(1),
    /** Validity (FEAT-011 D3): from 00:00 SGT on the start day; until 00:00 SGT after the end day. */
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Extracted facts (FEAT-012): the source, the extraction confidence and the passage. */
    sourceId: uuid('source_id'),
    confidence: real('confidence'),
    /** `{ url, title, quote, start, end }`: where on the page the fact was found (KB-05). */
    provenance: jsonb('provenance'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('facts_tenant_source_idx').on(t.tenantId, t.sourceId),
    foreignKey({
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [kbSources.tenantId, kbSources.id],
    }),
    check(
      'facts_provenance_ck',
      sql`${t.sourceId} is null or (${t.provenance} is not null and ${t.confidence} between 0 and 1)`,
    ),
    index('facts_tenant_status_updated_idx').on(t.tenantId, t.status, t.updatedAt.desc()),
    index('facts_tenant_updated_idx').on(t.tenantId, t.updatedAt.desc(), t.id.desc()),
    check('facts_type_ck', sql`${t.type} in ('product', 'faq', 'policy', 'promotion')`),
    check(
      'facts_status_ck',
      sql`${t.status} in ('needs_review', 'approved', 'rejected', 'conflicted', 'disabled')`,
    ),
    check(
      'facts_gst_ck',
      sql`(${t.gstTreatment} is null or ${t.gstTreatment} in ('inclusive', 'exclusive', 'unknown')) and ((${t.type} = 'product' and ${t.gstTreatment} is not null) or (${t.type} in ('faq', 'policy') and ${t.gstTreatment} is null) or (${t.type} = 'promotion' and (${t.value} ? 'priceCents') = (${t.gstTreatment} is not null)))`,
    ),
    check(
      'facts_validity_ck',
      sql`(${t.type} <> 'promotion' or ${t.validUntil} is not null) and (${t.validFrom} is null or ${t.validUntil} is null or ${t.validFrom} < ${t.validUntil})`,
    ),
  ],
);

/** Immutable fact versions (KB-14). No role may update them. */
export const factVersions = pgTable(
  'fact_versions',
  {
    tenantId: uuid('tenant_id').notNull(),
    factId: uuid('fact_id').notNull(),
    version: integer('version').notNull(),
    status: text('status', { enum: FACT_STATUSES }).notNull(),
    value: jsonb('value').notNull(),
    gstTreatment: text('gst_treatment', { enum: GST_TREATMENTS }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    changedBy: text('changed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.factId, t.version] }),
    foreignKey({ columns: [t.tenantId, t.factId], foreignColumns: [facts.tenantId, facts.id] }),
  ],
);

/** Embedding dimensions: Cohere Embed Multilingual v3 (ADR-019). */
export const EMBEDDING_DIMENSIONS = 1024;

/** Searchable chunks (ADR-005). One per fact for now; document chunks arrive with FEAT-012. */
export const kbChunks = pgTable(
  'kb_chunks',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    factId: uuid('fact_id').notNull(),
    factVersion: integer('fact_version').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('kb_chunks_fact_uq').on(t.tenantId, t.factId),
    foreignKey({ columns: [t.tenantId, t.factId], foreignColumns: [facts.tenantId, facts.id] }),
  ],
);

/**
 * Facts found by extraction, waiting for the source's promote stage (ADR-018 decision 7).
 * Rows live only between extract and promote; promote moves them into `facts` in one
 * transaction, so a failed run leaves no fact behind (KB-12).
 */
export const kbStagedFacts = pgTable(
  'kb_staged_facts',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    sourceId: uuid('source_id').notNull(),
    attempt: integer('attempt').notNull(),
    pageId: uuid('page_id').notNull(),
    type: text('type', { enum: FACT_TYPES }).notNull(),
    value: jsonb('value').notNull(),
    gstTreatment: text('gst_treatment', { enum: GST_TREATMENTS }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    quote: text('quote').notNull(),
    quoteStart: integer('quote_start').notNull(),
    quoteEnd: integer('quote_end').notNull(),
    confidence: real('confidence').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('kb_staged_facts_source_idx').on(t.tenantId, t.sourceId, t.attempt),
    foreignKey({
      columns: [t.tenantId, t.pageId],
      foreignColumns: [kbSourcePages.tenantId, kbSourcePages.id],
    }),
    check('kb_staged_facts_type_ck', sql`${t.type} in (${inList(FACT_TYPES)})`),
    check(
      'kb_staged_facts_quote_ck',
      sql`${t.confidence} between 0 and 1 and ${t.quoteStart} >= 0 and ${t.quoteEnd} > ${t.quoteStart}`,
    ),
  ],
);

/** Transactional outbox (ADR-012): written in the same transaction as the state change. */
export const outbox = pgTable(
  'outbox',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    topic: text('topic', { enum: ['conversation-turns', 'ingest'] }).notNull(),
    /** FIFO message group (the conversation ID for turns). */
    groupKey: text('group_key').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('outbox_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.dispatchedAt} is null`),
  ],
);

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/**
 * The audit log (ADR-014): one hash chain per tenant. Entries hold IDs, codes, numbers
 * and masked values only; personal data an entry needs lives in `audit_pii`. Appends go
 * through `audit_head_lock()` and a trigger that checks `seq` and `prev_hash` and moves
 * the head; no role can update or delete an entry (migration 0005).
 */
export const auditEntries = pgTable(
  'audit_entries',
  {
    tenantId: uuid('tenant_id').notNull(),
    /** Gap-free per tenant, from 1. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    ts: timestamp('ts', { withTimezone: true, precision: 3 }).notNull(),
    actorType: text('actor_type', {
      enum: ['agent', 'user', 'operator', 'system', 'visitor'],
    }).notNull(),
    actorRef: text('actor_ref'),
    eventType: text('event_type').notNull(),
    /** `type:id`, the primary subject first. */
    subjectRefs: text('subject_refs').array().notNull(),
    payload: jsonb('payload').notNull().default({}),
    piiRef: uuid('pii_ref'),
    piiCommitment: text('pii_commitment'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.seq] }),
    index('audit_entries_tenant_ts_idx').on(t.tenantId, t.ts),
    index('audit_entries_subject_refs_idx').using('gin', t.subjectRefs),
    check(
      'audit_entries_actor_type_check',
      sql`${t.actorType} in ('agent', 'user', 'operator', 'system', 'visitor')`,
    ),
    check('audit_entries_pii_pair', sql`(${t.piiRef} is null) = (${t.piiCommitment} is null)`),
    check(
      'audit_entries_hash_format',
      sql`${t.hash} ~ '^[0-9a-f]{64}$' and ${t.prevHash} ~ '^[0-9a-f]{64}$' and (${t.piiCommitment} is null or ${t.piiCommitment} ~ '^[0-9a-f]{64}$')`,
    ),
    check('audit_entries_seq_positive', sql`${t.seq} > 0`),
  ],
);

/** Each tenant's chain head (ADR-014 decision 4). Only the audit functions touch it. */
export const auditHeads = pgTable('audit_heads', {
  tenantId: uuid('tenant_id').primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  hash: text('hash').notNull(),
  /** The last `seq` written to the S3 Object Lock anchors. */
  anchoredSeq: bigint('anchored_seq', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Personal data an audit entry needs (ADR-014 decision 2). Deleted with the contact;
 * the entry keeps `pii_ref` and a salted commitment, so the chain still verifies.
 */
export const auditPii = pgTable(
  'audit_pii',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    // No FK yet: `contacts` arrives with FEAT-049.
    contactId: uuid('contact_id'),
    salt: bytea('salt').notNull(),
    data: jsonb('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('audit_pii_contact_idx').on(t.tenantId, t.contactId),
  ],
);

// ---- Identity (ADR-020; FEAT-005) ------------------------------------------------------

/**
 * A person who signs in (architecture §5.3 USER). Not tenant data: one user can belong
 * to several tenants through `memberships` (AUTH-04). Only the identity zone can read it.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Trimmed and lower-cased. */
    email: text('email').notNull().unique(),
    /** Bound on the first Google sign-in; a later one must match (FEAT-005 §5.4). */
    googleSub: text('google_sub').unique(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  },
  (t) => [check('users_status_ck', sql`${t.status} in ('active', 'disabled')`)],
);

export const ROLES = ['owner', 'admin', 'agent'] as const;

/** A user's place in a tenant (MEMBERSHIP). The role is re-read on every request. */
export const memberships = pgTable(
  'memberships',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ROLES }).notNull(),
    status: text('status', { enum: ['active', 'deactivated'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index('memberships_user_idx').on(t.userId),
    check('memberships_role_ck', sql`${t.role} in ('owner', 'admin', 'agent')`),
    check('memberships_status_ck', sql`${t.status} in ('active', 'deactivated')`),
  ],
);

export const TERMS_DOCUMENTS = ['tos', 'aup', 'dpa'] as const;

/** AUTH-08: who accepted which version of which document, and when. Insert-only. */
export const termsAcceptances = pgTable(
  'terms_acceptances',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    document: text('document', { enum: TERMS_DOCUMENTS }).notNull(),
    version: text('version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('terms_acceptances_document_idx').on(t.tenantId, t.document, t.acceptedAt.desc()),
    check('terms_acceptances_document_ck', sql`${t.document} in ('tos', 'aup', 'dpa')`),
  ],
);

/**
 * Server-side sessions (ADR-020): the cookie holds a random token, this table its
 * SHA-256. `active_tenant_id` is the user's current workspace, re-checked against
 * `memberships` on every request; it is not ownership, so the table isn't tenant-scoped.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: bytea('token_hash').notNull().unique(),
    activeTenantId: uuid('active_tenant_id').references(() => tenants.id),
    authMethod: text('auth_method', { enum: ['magic_link', 'google'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** The last fresh authentication, for AUTH-03's 10-minute re-auth window (FEAT-006). */
    reauthAt: timestamp('reauth_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('sessions_user_live_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
    check('sessions_auth_method_ck', sql`${t.authMethod} in ('magic_link', 'google')`),
  ],
);

/**
 * Magic links (ADR-020): the token's SHA-256 only. The token itself is
 * HMAC(MAGIC_LINK_SECRET, id), so a retry can re-derive it (FEAT-005 D6).
 */
export const magicLinks = pgTable(
  'magic_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sendAttempts: integer('send_attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('magic_links_unsent_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.sentAt} is null`),
    index('magic_links_created_idx').on(t.createdAt),
  ],
);

export const USAGE_PURPOSES = [
  'triage',
  'reply',
  'extract',
  'summarise',
  'judge',
  'embed',
] as const;

/**
 * The usage ledger (ADR-021, FEAT-004): one row per model or embedding call, IDs and
 * counts only. Feeds the cost governor (ADR-007 decision 3), and later DSH-08 and the
 * operator console. Writers insert; nobody updates or deletes.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    conversationId: uuid('conversation_id'),
    /** The visitor message the turn answers. */
    turnId: uuid('turn_id'),
    purpose: text('purpose', { enum: USAGE_PURPOSES }).notNull(),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    providerModelId: text('provider_model_id').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull().default(0),
    cacheWriteInputTokens: integer('cache_write_input_tokens').notNull().default(0),
    /** USD at the registry price when written (FEAT-004 D5). */
    costUsd: numeric('cost_usd', { precision: 14, scale: 10, mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('usage_events_tenant_created_idx').on(t.tenantId, t.createdAt),
    check(
      'usage_events_counts_ck',
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.cacheReadInputTokens} >= 0 and ${t.cacheWriteInputTokens} >= 0 and ${t.costUsd} >= 0`,
    ),
    check(
      'usage_events_purpose_ck',
      sql`${t.purpose} in ('triage', 'reply', 'extract', 'summarise', 'judge', 'embed')`,
    ),
  ],
);

/** Tables with `tenant_id` + forced RLS. The cross-tenant suite asserts this list is complete. */
export const TENANT_SCOPED_TABLES = [
  'tenants',
  'conversations',
  'messages',
  'outbox',
  'audit_entries',
  'audit_heads',
  'audit_pii',
  'business_profiles',
  'holidays',
  'assistant_settings',
  'facts',
  'fact_versions',
  'kb_chunks',
  'kb_sources',
  'kb_source_pages',
  'kb_staged_facts',
  'memberships',
  'terms_acceptances',
  'usage_events',
] as const;
