/**
 * Suggested replies through the real pipeline on the fake provider (INB-03, UC-23 4;
 * FEAT-045 §5.1; AC-1, AC-2, AC-5, AC-6).
 */
import { randomUUID } from 'node:crypto';
import { usageSink } from '@kaki/analytics';
import { SAFE_DEFAULTS, saveRules, type BoundaryRules } from '@kaki/approvals';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import {
  appendVisitorMessage,
  ConversationNotFoundError,
  createConversation,
  NotOwnerError,
  SUGGESTIONS_PER_HOUR,
  takeOver,
} from '@kaki/inbox';
import { createFact, dashboardKb, prepareChunk, type FactInput } from '@kaki/kb';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  gatewayFromConfig,
  type FakeScript,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeAgentScript,
  NothingToAnswerError,
  suggestReply,
  SuggestPausedError,
  TooManySuggestionsError,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const MEI = '00000000-0000-4000-8000-0000000000a1';
const KEN = '00000000-0000-4000-8000-0000000000b2';
const embedder = gatewayFromConfig({ provider: 'fake' });
let fudge: string;
let tart: string;

const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};
const TART: FactInput = {
  type: 'product',
  value: { name: 'Lemon tart', priceCents: 900, currency: 'SGD' },
  gstTreatment: 'inclusive',
};

async function create(input: FactInput) {
  const chunk = await prepareChunk(embedder, TENANT_A, input);
  return (
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      createFact(dashboardKb(tx, TENANT_A, MEI), input, chunk),
    )
  ).id;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  fudge = await create(FUDGE);
  tart = await create(TART);
  await owner.query(`update facts set status = 'needs_review' where id = $1`, [tart]);
});
beforeEach(async () => {
  const day = [{ open: '00:00', close: '24:00' }];
  await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
    TENANT_A,
    { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
  ]);
});
afterEach(async () => {
  await owner.query(
    `update tenants set ai_paused = false, ai_paused_at = null, ai_paused_by = null`,
  );
  await owner.query(`delete from boundary_rules`);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

function gateway(script: FakeScript = fakeAgentScript) {
  return createGateway(defaultRegistry('fake'), [createFakeProvider(script)], {
    onUsage: usageSink(tdb.zone('dashboard'), { warn: () => {} }),
  });
}
const deps = (script?: FakeScript) => ({ zdb: tdb.zone('dashboard'), llm: gateway(script) });

/** A conversation Mei has taken over, with the visitor's questions. */
async function handled(...questions: string[]) {
  const visitorId = randomUUID();
  const conv = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    createConversation(tx, TENANT_A, visitorId),
  );
  for (const text of questions)
    await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      appendVisitorMessage(tx, {
        tenantId: TENANT_A,
        conversationId: conv.id,
        visitorId,
        text,
        clientMessageId: randomUUID(),
      }),
    );
  const v = (await owner.query(`select version from conversations where id = $1`, [conv.id]))
    .rows[0].version;
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    takeOver(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      userId: MEI,
      visitorName: 'Mei Ling',
      version: v,
    }),
  );
  return conv.id;
}

const suggest = (conversationId: string, script?: FakeScript, userId = MEI) =>
  suggestReply(deps(script), { tenantId: TENANT_A, conversationId, userId });

async function saveBlocked(rules: Partial<BoundaryRules>) {
  const current = await owner.query(
    `select max(version)::int as v from boundary_rules where tenant_id = $1`,
    [TENANT_A],
  );
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    saveRules(tx, TENANT_A, {
      expectedVersion: current.rows[0].v,
      rules: { ...SAFE_DEFAULTS, ...rules },
      userId: MEI,
    }),
  );
}

describe('suggestReply (AC-1, AC-2)', () => {
  it('a price question: a ready draft with the slot-rendered price and its facts; no message or outbox row, metered on the conversation', async () => {
    const id = await handled('How much is the chocolate fudge cake?');
    const before = await owner.query(
      `select count(*)::int as n from messages where conversation_id = $1`,
      [id],
    );
    const outbox = (await owner.query(`select count(*)::int as n from outbox`)).rows[0].n;
    const s = await suggest(id);
    expect(s).toMatchObject({ outcome: 'ready', status: 'open', language: 'en' });
    expect(s.body).toContain('S$55.00');
    expect(s.factIds).toEqual([fudge]);
    const after = await owner.query(
      `select count(*)::int as n from messages where conversation_id = $1`,
      [id],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect((await owner.query(`select count(*)::int as n from outbox`)).rows[0].n).toBe(outbox);
    const usage = await owner.query(
      `select distinct conversation_id, coaching_session_id from usage_events where conversation_id = $1`,
      [id],
    );
    expect(usage.rows).toEqual([{ conversation_id: id, coaching_session_id: null }]);
    const audit = await owner.query(
      `select payload from audit_entries where event_type = 'inbox.suggestion.created' and $1 = any(subject_refs)`,
      [`suggestion:${s.id}`],
    );
    expect(audit.rows[0].payload).toMatchObject({
      suggestionId: s.id,
      outcome: 'ready',
      factIds: [fudge],
    });
    expect(JSON.stringify(audit.rows[0].payload)).not.toContain('55');
  });

  it('a reply that types a literal price twice gives no draft, never the unchecked text', async () => {
    const id = await handled('How much is the chocolate fudge cake?');
    const literal: FakeScript = (req) =>
      req.model === 'triage' ? fakeAgentScript(req) : 'The chocolate fudge cake is S$50.';
    const s = await suggest(id, literal);
    expect(s).toMatchObject({ outcome: 'no_checked_answer', body: null, factIds: [] });
  });

  it('never uses a needs_review fact', async () => {
    const id = await handled('How much is the lemon tart?');
    const s = await suggest(id);
    expect(s.factIds).not.toContain(tart);
    expect(s.body ?? '').not.toContain('S$9.00');
  });

  it('a blocked topic and a crisis give no draft', async () => {
    await saveBlocked({ blockedTopics: ['Politics'] });
    const blocked = await suggest(await handled('What do you think about politics?'));
    expect(blocked).toMatchObject({ outcome: 'no_checked_answer', body: null });
    const crisis = await suggest(await handled('i want to kill myself'));
    expect(crisis).toMatchObject({ outcome: 'no_checked_answer', body: null });
    const flagged = await owner.query(
      `select flagged_at from conversations where id = (select conversation_id from suggestions where id = $1)`,
      [crisis.id],
    );
    expect(flagged.rows[0].flagged_at).toBeNull();
  });

  it('answers a Chinese question in Chinese', async () => {
    const s = await suggest(await handled('chocolate fudge cake 多少钱？'));
    expect(s).toMatchObject({ outcome: 'ready', language: 'zh' });
  });

  it('answers the latest visitor message and supersedes the open draft', async () => {
    const id = await handled('Hello', 'How much is the chocolate fudge cake?');
    const first = await suggest(id);
    const second = await suggest(id);
    const q = await owner.query(`select body from messages where id = $1`, [second.forMessageId]);
    expect(q.rows[0].body).toBe('How much is the chocolate fudge cake?');
    const rows = await owner.query(`select id, status from suggestions where id = any($1)`, [
      [first.id, second.id],
    ]);
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.status]))).toEqual({
      [first.id]: 'superseded',
      [second.id]: 'open',
    });
  });
});

describe('refusals (AC-5, AC-6)', () => {
  it('not the owner, a missing conversation, paused, nothing to answer', async () => {
    const id = await handled('How much is the chocolate fudge cake?');
    await expect(suggest(id, undefined, KEN)).rejects.toBeInstanceOf(NotOwnerError);
    await expect(suggest(randomUUID())).rejects.toBeInstanceOf(ConversationNotFoundError);
    await owner.query(`update tenants set ai_paused = true, ai_paused_at = now() where id = $1`, [
      TENANT_A,
    ]);
    await expect(suggest(id)).rejects.toBeInstanceOf(SuggestPausedError);
    await owner.query(`update tenants set ai_paused = false, ai_paused_at = null where id = $1`, [
      TENANT_A,
    ]);
    await expect(suggest(await handled())).rejects.toBeInstanceOf(NothingToAnswerError);
  });

  it(`the ${SUGGESTIONS_PER_HOUR + 1}th in an hour is refused with a retry time`, async () => {
    const id = await handled('How much is the chocolate fudge cake?');
    const q = await owner.query(
      `select id from messages where conversation_id = $1 and author = 'visitor'`,
      [id],
    );
    for (let i = 0; i < SUGGESTIONS_PER_HOUR; i++)
      await owner.query(
        `insert into suggestions (tenant_id, conversation_id, for_message_id, requested_by, outcome, language)
         values ($1, $2, $3, $4, 'unavailable', 'en')`,
        [TENANT_A, id, q.rows[0].id, MEI],
      );
    const err = await suggest(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooManySuggestionsError);
    expect((err as TooManySuggestionsError).retryAfterS).toBeGreaterThan(3500);
  });
});
