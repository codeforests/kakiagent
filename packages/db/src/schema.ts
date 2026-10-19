import { sql } from 'drizzle-orm';
import {
  bigint,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
] as const;
