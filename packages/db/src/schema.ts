import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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

export const tenants = pgTable('tenants', {
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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

export const FACT_TYPES = ['product', 'faq'] as const;
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
    /** product: { name, priceCents, currency: 'SGD', unit? }; faq: { question, answer }. */
    value: jsonb('value').notNull(),
    gstTreatment: text('gst_treatment', { enum: GST_TREATMENTS }),
    source: text('source').notNull().default('manual'),
    version: integer('version').notNull().default(1),
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
    check('facts_type_ck', sql`${t.type} in ('product', 'faq')`),
    check(
      'facts_status_ck',
      sql`${t.status} in ('needs_review', 'approved', 'rejected', 'conflicted', 'disabled')`,
    ),
    check(
      'facts_gst_ck',
      sql`(${t.type} = 'product') = (${t.gstTreatment} is not null) and (${t.gstTreatment} is null or ${t.gstTreatment} in ('inclusive', 'exclusive', 'unknown'))`,
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

/**
 * Audit events (ADR-014). IDs only, never personal data. FEAT-002 adds the per-tenant
 * hash chain, verification and anchoring.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    action: text('action').notNull(),
    actorType: text('actor_type', { enum: ['visitor', 'agent', 'user', 'system'] }).notNull(),
    actorId: text('actor_id'),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('audit_events_tenant_seq_idx').on(t.tenantId, t.seq),
  ],
);

/** Tables with `tenant_id` + forced RLS. The cross-tenant suite asserts this list is complete. */
export const TENANT_SCOPED_TABLES = [
  'tenants',
  'conversations',
  'messages',
  'outbox',
  'audit_events',
  'business_profiles',
  'facts',
  'fact_versions',
  'kb_chunks',
] as const;
