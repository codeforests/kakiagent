/**
 * Gap grouping (KB-09, KB-18; FEAT-019 §4, AC-5, AC-8): `kb_gap_cluster()` run as the
 * outbox zone, the way scheduler-worker runs it, on crafted 1024-d vectors.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '../src/testing.js';

let tdb: TestDatabase;
let owner: pg.Client;

async function cluster() {
  const c = new pg.Client({ connectionString: tdb.urlFor('app_outbox') });
  await c.connect();
  try {
    return (await c.query(`select * from kb_gap_cluster()`)).rows as {
      tenant_id: string;
      grouped: number;
      opened: number;
      closed: number;
    }[];
  } finally {
    await c.end();
  }
}

/** A unit vector along `axis`, tilted towards `axis + 1` by `tilt` (0 = on the axis). */
function vec(axis: number, tilt = 0) {
  const v = new Array<number>(1024).fill(0);
  v[axis] = 1;
  v[axis + 1] = tilt;
  const n = Math.hypot(1, tilt);
  return `[${v.map((x) => x / n).join(',')}]`;
}

async function gap(tenantId: string, embedding: string, opts: { daysAgo?: number } = {}) {
  const conv = await owner.query(
    `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
    [tenantId],
  );
  const { rows } = await owner.query(
    `insert into messages (tenant_id, conversation_id, author, body, gap_reason, gap_embedding, created_at)
     values ($1, $2, 'visitor', 'Do you deliver to Tampines?', 'unavailable', $3, now() - make_interval(days => $4))
     returning id`,
    [tenantId, conv.rows[0].id, embedding, opts.daysAgo ?? 0],
  );
  return { id: rows[0].id as string, conversationId: conv.rows[0].id as string };
}

const itemOf = async (messageId: string) =>
  (await owner.query(`select gap_correction_id from messages where id = $1`, [messageId])).rows[0]
    .gap_correction_id as string | null;

const item = async (id: string) =>
  (
    await owner.query(
      `select source_type, proposed_by, status, decided_by, conversation_ref, proposed_change, fact_refs
       from corrections where id = $1`,
      [id],
    )
  ).rows[0];

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});

beforeEach(async () => {
  await owner.query(`delete from messages`);
  await owner.query(`delete from corrections`);
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('kb_gap_cluster', () => {
  it('puts two near gaps in one item and a far one in a second, with no visitor text', async () => {
    const a = await gap(TENANT_A, vec(0));
    const b = await gap(TENANT_A, vec(0, 0.3));
    const far = await gap(TENANT_A, vec(10));
    expect(await cluster()).toEqual([{ tenant_id: TENANT_A, grouped: 3, opened: 2, closed: 0 }]);
    const [ia, ib, ifar] = [await itemOf(a.id), await itemOf(b.id), await itemOf(far.id)];
    expect(ia).not.toBeNull();
    expect(ib).toBe(ia);
    expect(ifar).not.toBe(ia);
    expect(await item(ia!)).toEqual({
      source_type: 'coverage_gap',
      proposed_by: 'system',
      status: 'open',
      decided_by: null,
      conversation_ref: a.conversationId,
      proposed_change: { kind: 'answer_gap' },
      fact_refs: [],
    });
    expect(await cluster()).toEqual([]);
  });

  it('a later near gap joins the open item; one near an accepted or dismissed item opens a new one', async () => {
    const first = await gap(TENANT_A, vec(0));
    await cluster();
    const open = (await itemOf(first.id))!;
    const later = await gap(TENANT_A, vec(0, 0.2));
    expect(await cluster()).toEqual([{ tenant_id: TENANT_A, grouped: 1, opened: 0, closed: 0 }]);
    expect(await itemOf(later.id)).toBe(open);

    await owner.query(
      `update corrections set status = 'edited_and_accepted', decided_at = now(), accepted_change = '{}' where id = $1`,
      [open],
    );
    const afterAccept = await gap(TENANT_A, vec(0, 0.1));
    expect(await cluster()).toEqual([{ tenant_id: TENANT_A, grouped: 1, opened: 1, closed: 0 }]);
    const reopened = (await itemOf(afterAccept.id))!;
    expect(reopened).not.toBe(open);

    await owner.query(
      `update corrections set status = 'dismissed', decided_at = now() where id = $1`,
      [reopened],
    );
    const afterClose = await gap(TENANT_A, vec(0));
    await cluster();
    expect([open, reopened]).not.toContain(await itemOf(afterClose.id));
  });

  it("doesn't join a gap asked more than 60 days ago, nor another tenant's", async () => {
    const old = await gap(TENANT_A, vec(0), { daysAgo: 61 });
    await cluster();
    const fresh = await gap(TENANT_A, vec(0));
    const other = await gap(TENANT_B, vec(0));
    expect(await cluster()).toEqual(
      [
        { tenant_id: TENANT_A, grouped: 1, opened: 1, closed: 0 },
        { tenant_id: TENANT_B, grouped: 1, opened: 1, closed: 0 },
      ].sort((x, y) => x.tenant_id.localeCompare(y.tenant_id)),
    );
    expect(await itemOf(fresh.id)).not.toBe(await itemOf(old.id));
    expect(await itemOf(other.id)).not.toBe(await itemOf(fresh.id));
  });

  it('closes an item whose messages were all erased, with no decider, and changes no fact', async () => {
    const facts = await owner.query(`select count(*)::int as n from facts`);
    const a = await gap(TENANT_A, vec(0));
    const keep = await gap(TENANT_A, vec(10));
    await cluster();
    const gone = (await itemOf(a.id))!;
    await owner.query(`delete from messages where id = $1`, [a.id]);
    expect(await cluster()).toEqual([{ tenant_id: TENANT_A, grouped: 0, opened: 0, closed: 1 }]);
    expect(await item(gone)).toMatchObject({ status: 'dismissed', decided_by: null });
    expect(await item((await itemOf(keep.id))!)).toMatchObject({ status: 'open' });
    expect((await owner.query(`select count(*)::int as n from facts`)).rows[0]).toEqual(
      facts.rows[0],
    );
  });

  it('the checks keep a reason and its vector together and reject unknown reasons', async () => {
    const conv = await owner.query(
      `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
      [TENANT_A],
    );
    for (const [reason, emb] of [
      ['unavailable', null],
      [null, vec(0)],
      ['answered', vec(0)],
    ])
      await expect(
        owner.query(
          `insert into messages (tenant_id, conversation_id, author, body, gap_reason, gap_embedding)
           values ($1, $2, 'visitor', 'q', $3, $4)`,
          [TENANT_A, conv.rows[0].id, reason, emb],
        ),
      ).rejects.toThrow(/messages_gap_ck/);
  });
});
