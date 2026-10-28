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
    /**
     * Widget key and allowed origins (CHN-11): stay here (FEAT-032 D2), because
     * `resolve_widget_key` and FEAT-012's source write read them; the rest of the widget's
     * settings are in `widget_settings`, owned by the channels module.
     */
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
    /** Months before an approved fact of each type is due for re-confirmation (KB-17, FEAT-018 D6). */
    factReviewMonths: jsonb('fact_review_months')
      .$type<{ product: number; faq: number; policy: number; promotion: number }>()
      .notNull()
      .default(sql`'{"product":6,"faq":6,"policy":6,"promotion":6}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FEAT-032 §4: 20 by hand, plus FEAT-012's confirmed website hosts.
    check('tenants_allowed_origins_ck', sql`cardinality(${t.allowedOrigins}) <= 50`),
    check(
      'tenants_route_complexity_threshold_ck',
      sql`${t.routeComplexityThreshold} between 0 and 1`,
    ),
    check('tenants_route_min_confidence_ck', sql`${t.routeMinConfidence} between 0 and 1`),
    check('tenants_cost_governor_step_ck', sql`${t.costGovernorStep} between 0 and 3`),
    check(
      'tenants_fact_review_months_ck',
      sql`jsonb_typeof(${t.factReviewMonths} -> 'product') = 'number' and (${t.factReviewMonths} -> 'product')::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24) and jsonb_typeof(${t.factReviewMonths} -> 'faq') = 'number' and (${t.factReviewMonths} -> 'faq')::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24) and jsonb_typeof(${t.factReviewMonths} -> 'policy') = 'number' and (${t.factReviewMonths} -> 'policy')::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24) and jsonb_typeof(${t.factReviewMonths} -> 'promotion') = 'number' and (${t.factReviewMonths} -> 'promotion')::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24)`,
    ),
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
    /** Template topic IDs the owner marked "Doesn't apply" on Coverage (FEAT-019 D8). */
    coverageSkippedTopics: text('coverage_skipped_topics')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'business_profiles_coverage_skipped_ck',
      sql`cardinality(${t.coverageSkippedTopics}) <= 100`,
    ),
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
/** Embedding dimensions: Cohere Embed Multilingual v3 (ADR-019). */
export const EMBEDDING_DIMENSIONS = 1024;
/** Turn outcomes that make a visitor question a coverage gap (FEAT-019 D2). */
export const GAP_REASONS = ['unavailable', 'unsure', 'escalated'] as const;
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
    /** The reply language the agent decided (FEAT-033 D3); null on visitor and staff rows. */
    language: text('language', { enum: ['en', 'zh'] }),
    /**
     * Set on a visitor question the turn couldn't answer (FEAT-019 §4, D2), with the
     * retrieval vector; the gap-grouping job files it under a `coverage_gap` correction.
     */
    gapReason: text('gap_reason', { enum: GAP_REASONS }),
    gapEmbedding: vector('gap_embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    gapCorrectionId: uuid('gap_correction_id'),
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
    /** "Past questions that used this fact" (FEAT-018 §5.3). */
    index('messages_fact_ids_gin').using('gin', t.factIds),
    check(
      'messages_notice_ck',
      sql`(${t.notice} is null) = (${t.noticeKind} is null) and (${t.noticeKind} is null or ${t.noticeKind} in ('after_hours', 'chat_ended'))`,
    ),
    check('messages_language_ck', sql`${t.language} in ('en', 'zh')`),
    foreignKey({
      columns: [t.tenantId, t.gapCorrectionId],
      foreignColumns: [corrections.tenantId, corrections.id],
    }),
    /** The gap-grouping job's backlog (FEAT-019 §4). */
    index('messages_gap_backlog_idx')
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.gapReason} is not null and ${t.gapCorrectionId} is null`),
    /** Counts and newest asks per gap item. */
    index('messages_gap_correction_idx')
      .on(t.tenantId, t.gapCorrectionId, t.createdAt.desc())
      .where(sql`${t.gapCorrectionId} is not null`),
    check(
      'messages_gap_ck',
      sql`(${t.gapReason} is null) = (${t.gapEmbedding} is null) and (${t.gapCorrectionId} is null or ${t.gapReason} is not null) and (${t.gapReason} is null or ${t.gapReason} in ('unavailable', 'unsure', 'escalated'))`,
    ),
  ],
);

export const SOURCE_KINDS = ['website', 'file', 'spreadsheet', 'chat'] as const;
export const SOURCE_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const;
/** `map` waits for the owner's column mapping with no job (FEAT-016 D3); `import` applies it. */
export const SOURCE_STAGES = [
  'scan',
  'parse',
  'map',
  'import',
  'crawl',
  'extract',
  'promote',
] as const;
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
  // Spreadsheets (FEAT-016 §3.1): no table in the file, or no row valid under the mapping.
  'no_rows',
  'no_valid_rows',
  // Chat exports (FEAT-017 §3.1): not an export we can read (UC-11 2a), or no business message.
  'chat_format',
  'business_not_found',
] as const;
/** What a file's bytes are (FEAT-015 §5.3), whatever its name says. */
export const FILE_TYPES = [
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
] as const;
/** The types a spreadsheet source may be (FEAT-016 §5.2). */
export const SHEET_TYPES = ['xlsx', 'csv'] as const;
/** The types a chat export may be (FEAT-017 §5.2): WhatsApp text or iOS zip, Telegram JSON. */
export const CHAT_TYPES = ['txt', 'json', 'zip'] as const;
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
  // Spreadsheet rows (FEAT-016 §5.5): skipped as empty, or rejected with the first rule that fails.
  'empty_row',
  'no_name',
  'no_price',
  'bad_price',
  'not_sgd',
  'bad_stock',
  'too_long',
] as const;

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * Knowledge sources (KB_SOURCE, ADR-018 decision 1): one row per website (FEAT-012),
 * uploaded file (FEAT-015), spreadsheet (FEAT-016) or chat export (FEAT-017).
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
    /**
     * Spreadsheets (FEAT-016 §4): the layout the parse found (sheet, header, columns with
     * samples, the suggested mapping), and the owner's confirmed mapping.
     */
    sheet: jsonb('sheet'),
    mapping: jsonb('mapping'),
    /**
     * Chat exports (FEAT-017 §4): the redacted summary the parse wrote (format, days,
     * counts, redactions, when the export was deleted) and the owner's business names.
     */
    chat: jsonb('chat'),
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
      sql`${t.kind} not in ('file', 'spreadsheet', 'chat') or (${t.uploadKey} is not null and ${t.fileSize} > 0)`,
    ),
    check(
      'kb_sources_sheet_type_ck',
      sql`${t.fileType} is null or (${t.kind} = 'spreadsheet') = (${t.fileType} in (${inList(SHEET_TYPES)}))`,
    ),
    check('kb_sources_mapping_ck', sql`${t.mapping} is null or ${t.kind} = 'spreadsheet'`),
    check(
      'kb_sources_chat_type_ck',
      sql`${t.kind} <> 'chat' or ${t.fileType} is null or ${t.fileType} in (${inList(CHAT_TYPES)})`,
    ),
    check('kb_sources_chat_ck', sql`${t.chat} is null or ${t.kind} = 'chat'`),
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
 * attempt, or a spreadsheet's rows (FEAT-016 D1). `content` is masked visible text
 * (ADR-015). A file page's `url` is a locator, `page/3`, `slide/2`, `part/1`, `image/1`, or
 * a row's `row/12` (its row number in the sheet).
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
    /** A spreadsheet row's cells, masked (FEAT-016 §4); null for other pages. */
    cells: text('cells').array(),
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
    check('kb_source_pages_cells_ck', sql`${t.cells} is null or cardinality(${t.cells}) <= 50`),
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
     * product: { name, priceCents, currency: 'SGD', unit?, sku?, stock?, stockAsOf? } (the last
     * three from a spreadsheet, FEAT-016 D8); faq: { question, answer };
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
    /** A coaching turn's session (FEAT-027 §5.3): metered, never counted per conversation. */
    coachingSessionId: uuid('coaching_session_id'),
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
    check(
      'usage_events_owner_ck',
      sql`${t.conversationId} is null or ${t.coachingSessionId} is null`,
    ),
  ],
);

export const CORRECTION_SOURCES = [
  'thumbs_down',
  'staff_reply',
  'staff_edit',
  'coaching',
  'oversight',
  'stale',
  'coverage_gap',
] as const;
export const CORRECTION_STATUSES = [
  'open',
  'accepted',
  'edited_and_accepted',
  'dismissed',
] as const;

/**
 * The corrections queue (ADR-010 decision 4). Proposals never edit facts; confirming one
 * does, through the KB's write path. FEAT-027 writes `coaching` rows; FEAT-018 adds the
 * other producers, the queue screen and replay.
 */
export const corrections = pgTable(
  'corrections',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    sourceType: text('source_type', { enum: CORRECTION_SOURCES }).notNull(),
    proposedBy: text('proposed_by', { enum: ['system', 'coaching', 'staff'] }).notNull(),
    conversationRef: uuid('conversation_ref'),
    coachingSessionId: uuid('coaching_session_id'),
    coachingMessageId: uuid('coaching_message_id'),
    factRefs: uuid('fact_refs')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    proposedChange: jsonb('proposed_change').notNull(),
    /** What was accepted when the owner edited the fix (FEAT-018 D7); the proposal stays as proposed. */
    acceptedChange: jsonb('accepted_change'),
    status: text('status', { enum: CORRECTION_STATUSES }).notNull().default('open'),
    createdBy: uuid('created_by'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('corrections_tenant_status_created_idx').on(t.tenantId, t.status, t.createdAt.desc()),
    index('corrections_tenant_status_decided_idx').on(t.tenantId, t.status, t.decidedAt.desc()),
    /** One open stale item per fact (ADR-010 "de-duplicated by fact"). */
    uniqueIndex('corrections_open_stale_uq')
      .on(t.tenantId, sql`(${t.factRefs}[1])`)
      .where(sql`${t.sourceType} = 'stale' and ${t.status} = 'open'`),
    check(
      'corrections_accepted_change_ck',
      sql`(${t.status} = 'edited_and_accepted') = (${t.acceptedChange} is not null)`,
    ),
    check(
      'corrections_source_ck',
      sql`${t.sourceType} in ('thumbs_down', 'staff_reply', 'staff_edit', 'coaching', 'oversight', 'stale', 'coverage_gap')`,
    ),
    check('corrections_proposed_by_ck', sql`${t.proposedBy} in ('system', 'coaching', 'staff')`),
    check(
      'corrections_status_ck',
      sql`${t.status} in ('open', 'accepted', 'edited_and_accepted', 'dismissed')`,
    ),
    check('corrections_decided_ck', sql`(${t.status} = 'open') = (${t.decidedAt} is null)`),
    check(
      'corrections_coaching_ck',
      sql`${t.sourceType} <> 'coaching' or ${t.coachingSessionId} is not null`,
    ),
  ],
);

export const COACHING_ORIGINS = ['coach', 'setup', 'panel', 'replay', 'correction'] as const;
export const COACHING_MESSAGE_KINDS = [
  'question',
  'answer',
  'proposal',
  'after',
  'replay',
] as const;

/**
 * Coaching (AGT-17, ONB-05; FEAT-027 §4): the owner's playground chat with the assistant.
 * Shared by the tenant's Owner and Admins (D8). Dashboard trust zone only, never the
 * visitor role (ADR-009).
 */
export const coachingSessions = pgTable(
  'coaching_sessions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull().defaultRandom(),
    createdBy: uuid('created_by').notNull(),
    origin: text('origin', { enum: COACHING_ORIGINS }).notNull(),
    /** The first question, cut to 80 characters. */
    title: text('title'),
    /** A replay's conversation (FEAT-028 §4): replays go with their conversation (ADR-015). */
    replayConversationId: uuid('replay_conversation_id'),
    /** A replay's include-unreviewed choice, made once (FEAT-028 D6). */
    includeUnreviewed: boolean('include_unreviewed').notNull().default(false),
    /** A correction replay's correction (FEAT-018 §4): one replay per accepted correction. */
    correctionId: uuid('correction_id'),
    /** The visitor messages a correction replay re-answers, chosen at acceptance, newest first (D4). */
    replayQuestionIds: uuid('replay_question_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** All past questions that used the corrected facts, of which at most 20 replay. */
    replayMatched: integer('replay_matched'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('coaching_sessions_tenant_updated_idx').on(t.tenantId, t.updatedAt.desc(), t.id.desc()),
    index('coaching_sessions_tenant_replay_idx').on(
      t.tenantId,
      t.replayConversationId,
      t.createdAt.desc(),
    ),
    foreignKey({
      columns: [t.tenantId, t.replayConversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.correctionId],
      foreignColumns: [corrections.tenantId, corrections.id],
    }),
    uniqueIndex('coaching_sessions_correction_uq').on(t.tenantId, t.correctionId),
    check(
      'coaching_sessions_origin_ck',
      sql`${t.origin} in ('coach', 'setup', 'panel', 'replay', 'correction')`,
    ),
    check(
      'coaching_sessions_correction_ck',
      sql`(${t.origin} = 'correction') = (${t.correctionId} is not null)`,
    ),
    check(
      'coaching_sessions_replay_ck',
      sql`(${t.origin} = 'replay') = (${t.replayConversationId} is not null)`,
    ),
  ],
);

/** A coaching session's content, masked at the edge (D9). */
export const coachingMessages = pgTable(
  'coaching_messages',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    seq: integer('seq').notNull(),
    author: text('author', { enum: ['owner', 'agent'] }).notNull(),
    kind: text('kind', { enum: COACHING_MESSAGE_KINDS }).notNull(),
    body: text('body').notNull(),
    includeUnreviewed: boolean('include_unreviewed').notNull().default(false),
    outcome: text('outcome'),
    factIds: uuid('fact_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** The answer's explainer, built in code (D3). */
    explainer: jsonb('explainer'),
    correctionId: uuid('correction_id'),
    /** A replayed answer's original visitor message (FEAT-028 §4); no FK, it goes with its conversation. */
    replayOf: uuid('replay_of'),
    /** The replayed question's conversation: each answer goes with it (FEAT-018 D9, ADR-015). */
    replayConversationId: uuid('replay_conversation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [coachingSessions.tenantId, coachingSessions.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.replayConversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete('cascade'),
    uniqueIndex('coaching_messages_session_seq_uq').on(t.tenantId, t.sessionId, t.seq),
    uniqueIndex('coaching_messages_session_replay_uq').on(t.tenantId, t.sessionId, t.replayOf),
    check('coaching_messages_author_ck', sql`${t.author} in ('owner', 'agent')`),
    check(
      'coaching_messages_kind_ck',
      sql`${t.kind} in ('question', 'answer', 'proposal', 'after', 'replay')`,
    ),
    check('coaching_messages_replay_ck', sql`(${t.kind} = 'replay') = (${t.replayOf} is not null)`),
    check(
      'coaching_messages_replay_conversation_ck',
      sql`(${t.kind} = 'replay') = (${t.replayConversationId} is not null)`,
    ),
  ],
);

export const WIDGET_POSITIONS = ['right', 'left'] as const;
export const WIDGET_DETECT_STATUSES = ['none', 'queued', 'running', 'done', 'failed'] as const;
export const WIDGET_DETECT_FAILURES = ['unreachable', 'blocked', 'timeout', 'no_page'] as const;
export const WIDGET_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Website widget settings (ONB-07, CHN-14, CHN-02; FEAT-032 §4): one row per tenant, made
 * with the tenant. The channels module owns it. The visitor zone reads the look and writes
 * only the install check; the ingest zone writes only the detection result.
 */
export const widgetSettings = pgTable(
  'widget_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    position: text('position', { enum: WIDGET_POSITIONS }).notNull().default('right'),
    themeOverrides: jsonb('theme_overrides')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    detectedTheme: jsonb('detected_theme').$type<Record<string, unknown>>(),
    detectStatus: text('detect_status', { enum: WIDGET_DETECT_STATUSES }).notNull().default('none'),
    detectFailure: text('detect_failure', { enum: WIDGET_DETECT_FAILURES }),
    detectRequestedAt: timestamp('detect_requested_at', { withTimezone: true }),
    logo: bytea('logo'),
    logoType: text('logo_type', { enum: WIDGET_LOGO_TYPES }),
    logoVersion: integer('logo_version').notNull().default(0),
    installSeenAt: timestamp('install_seen_at', { withTimezone: true }),
    installSeenOrigin: text('install_seen_origin'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    rejectedOrigin: text('rejected_origin'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('widget_settings_position_ck', sql`${t.position} in ('right', 'left')`),
    check('widget_settings_overrides_ck', sql`jsonb_typeof(${t.themeOverrides}) = 'object'`),
    check(
      'widget_settings_detected_ck',
      sql`${t.detectedTheme} is null or jsonb_typeof(${t.detectedTheme}) = 'object'`,
    ),
    check(
      'widget_settings_detect_ck',
      sql`${t.detectStatus} in ('none', 'queued', 'running', 'done', 'failed') and (${t.detectFailure} is null or (${t.detectStatus} = 'failed' and ${t.detectFailure} in ('unreachable', 'blocked', 'timeout', 'no_page')))`,
    ),
    check(
      'widget_settings_logo_ck',
      sql`(${t.logo} is null) = (${t.logoType} is null) and (${t.logoType} is null or ${t.logoType} in ('image/png', 'image/jpeg', 'image/webp')) and (${t.logo} is null or octet_length(${t.logo}) <= 102400)`,
    ),
  ],
);

export const WORDING_KINDS = ['privacy_notice', 'purpose_statement'] as const;

/**
 * Privacy notice and purpose-statement wordings (GOV-14, LED-02; FEAT-058 §4, D3). Append-only:
 * a consent record will name a row by id, so `app_dashboard` may insert but never update or
 * delete. `content` is shaped by `@kaki/governance` (`NoticeContent`, `PurposeContent`).
 */
export const wordingVersions = pgTable(
  'wording_versions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull().defaultRandom(),
    kind: text('kind', { enum: WORDING_KINDS }).notNull(),
    seq: integer('seq').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('wording_versions_kind_seq_uq').on(t.tenantId, t.kind, t.seq),
    check('wording_versions_kind_ck', sql`${t.kind} in ('privacy_notice', 'purpose_statement')`),
    check('wording_versions_seq_ck', sql`${t.seq} >= 1`),
    check('wording_versions_content_ck', sql`jsonb_typeof(${t.content}) = 'object'`),
  ],
);

/**
 * The tenant's current privacy wordings (FEAT-058 §4): one row per tenant, absent until the
 * first save, with an optimistic `version` like assistant settings. The composite FKs keep a
 * pointer inside the tenant (ADR-005).
 */
export const privacySettings = pgTable(
  'privacy_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    noticeWordingId: uuid('notice_wording_id'),
    purposeWordingId: uuid('purpose_wording_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'privacy_settings_notice_fk',
      columns: [t.tenantId, t.noticeWordingId],
      foreignColumns: [wordingVersions.tenantId, wordingVersions.id],
    }),
    foreignKey({
      name: 'privacy_settings_purpose_fk',
      columns: [t.tenantId, t.purposeWordingId],
      foreignColumns: [wordingVersions.tenantId, wordingVersions.id],
    }),
  ],
);

export const CHANNEL_KINDS = [
  'widget',
  'email',
  'telegram',
  'messenger',
  'instagram',
  'whatsapp',
] as const;
export const CHANNEL_STATES = ['live', 'offline'] as const;
export const CHANNEL_OFFLINE_MODES = ['hidden', 'message'] as const;
export const CHANNEL_HEALTH = ['ok', 'degraded', 'unknown'] as const;
export const CHANNEL_HEALTH_REASONS = [
  'credential_revoked',
  'credential_invalid',
  'unreachable',
  'send_rejected',
] as const;

/**
 * One connection per channel kind per tenant (CHN-01, ONB-10, CHN-12; FEAT-034 §4, D1). A
 * trigger on `tenants` creates the widget row offline and hidden. The credential columns are
 * sealed (`@kaki/channels` `SecretSealer`) and not granted to the dashboard zone.
 */
export const channelConnections = pgTable(
  'channel_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: CHANNEL_KINDS }).notNull(),
    state: text('state', { enum: CHANNEL_STATES }).notNull().default('offline'),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }),
    stateChangedBy: uuid('state_changed_by'),
    offlineMode: text('offline_mode', { enum: CHANNEL_OFFLINE_MODES }).notNull().default('hidden'),
    offlineMessageEn: text('offline_message_en'),
    offlineMessageZh: text('offline_message_zh'),
    health: text('health', { enum: CHANNEL_HEALTH }).notNull().default('unknown'),
    healthReason: text('health_reason', { enum: CHANNEL_HEALTH_REASONS }),
    healthFailures: integer('health_failures').notNull().default(0),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),
    degradedSince: timestamp('degraded_since', { withTimezone: true }),
    credentialCiphertext: bytea('credential_ciphertext'),
    credentialKeyRef: text('credential_key_ref'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_connections_kind_uq').on(t.tenantId, t.kind),
    uniqueIndex('channel_connections_tenant_id_uq').on(t.tenantId, t.id),
    check(
      'channel_connections_kind_ck',
      sql`${t.kind} in ('widget', 'email', 'telegram', 'messenger', 'instagram', 'whatsapp')`,
    ),
    check('channel_connections_state_ck', sql`${t.state} in ('live', 'offline')`),
    check(
      'channel_connections_offline_mode_ck',
      sql`${t.offlineMode} in ('hidden', 'message') and (${t.kind} = 'widget' or ${t.offlineMode} = 'message')`,
    ),
    check(
      'channel_connections_offline_message_ck',
      sql`(${t.offlineMessageEn} is null or char_length(${t.offlineMessageEn}) between 1 and 300) and (${t.offlineMessageZh} is null or char_length(${t.offlineMessageZh}) between 1 and 300)`,
    ),
    check(
      'channel_connections_health_ck',
      sql`${t.health} in ('ok', 'degraded', 'unknown') and (${t.healthReason} is null or ${t.healthReason} in ('credential_revoked', 'credential_invalid', 'unreachable', 'send_rejected')) and ${t.healthFailures} >= 0`,
    ),
    check(
      'channel_connections_credential_ck',
      sql`(${t.credentialCiphertext} is null) = (${t.credentialKeyRef} is null)`,
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
  'coaching_sessions',
  'coaching_messages',
  'corrections',
  'widget_settings',
  'wording_versions',
  'privacy_settings',
  'channel_connections',
] as const;
