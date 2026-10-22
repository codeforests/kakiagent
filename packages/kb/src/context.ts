import type { Tx } from '@kaki/db';

/**
 * Scope-typed contexts (ADR-009). Visitor-scope functions take a `VisitorKbContext`,
 * dashboard functions a `DashboardKbContext`; the literal `scope` makes them
 * incompatible, so a visitor path cannot call a dashboard function. The database
 * grants back this up: the visitor role can't read `facts` at all.
 */
export interface DashboardKbContext {
  readonly scope: 'dashboard';
  tx: Tx;
  tenantId: string;
  userId: string;
}

export interface VisitorKbContext {
  readonly scope: 'visitor';
  tx: Tx;
  tenantId: string;
  conversationId: string;
}

/** The ingest worker's stages (FEAT-012): one source's run, in the ingest trust zone. */
export interface IngestKbContext {
  readonly scope: 'ingest';
  tx: Tx;
  tenantId: string;
  sourceId: string;
}

export const dashboardKb = (tx: Tx, tenantId: string, userId: string): DashboardKbContext => ({
  scope: 'dashboard',
  tx,
  tenantId,
  userId,
});

export const visitorKb = (tx: Tx, tenantId: string, conversationId: string): VisitorKbContext => ({
  scope: 'visitor',
  tx,
  tenantId,
  conversationId,
});

export const ingestKb = (tx: Tx, tenantId: string, sourceId: string): IngestKbContext => ({
  scope: 'ingest',
  tx,
  tenantId,
  sourceId,
});
