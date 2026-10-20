import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
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
 * Business profile (ONB-03). FEAT-022 needs only the GST flag (KB-15); FEAT-009 adds the
 * rest of the profile.
 */
export const businessProfiles = pgTable('business_profiles', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  gstRegistered: boolean('gst_registered').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('conversations_tenant_last_message_idx').on(t.tenantId, t.lastMessageAt.desc()),
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
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
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

/** Transactional outbox (ADR-012): written in the same transaction as the state change. */
export const outbox = pgTable(
  'outbox',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    topic: text('topic', { enum: ['conversation-turns'] }).notNull(),
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
  'facts',
  'fact_versions',
  'kb_chunks',
  'memberships',
  'terms_acceptances',
  'usage_events',
] as const;
