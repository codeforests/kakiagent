/** Conversation search on the real schema (INB-11; FEAT-046 §5.1, AC-1–AC-3, AC-6). */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadCursorError, QueryTooShortError, searchConversations } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

/** A conversation with its messages, last activity at `mins` past T0. */
async function conv(
  tenantId: string,
  mins: number,
  messages: { author: 'visitor' | 'agent' | 'staff' | 'system'; body: string }[],
  closed = false,
): Promise<{ id: string; messageIds: string[] }> {
  const { rows } = await owner.query(
    `insert into conversations (tenant_id, channel, visitor_id, status, last_message_at, closed_at, close_reason)
     values ($1, 'widget', gen_random_uuid(), $2, $3, $4, $5) returning id`,
    [
      tenantId,
      closed ? 'closed' : 'ai',
      at(mins),
      closed ? at(mins) : null,
      closed ? 'staff' : null,
    ],
  );
  const id = rows[0].id as string;
  const messageIds: string[] = [];
  for (const [i, msg] of messages.entries()) {
    const r = await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body, created_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [tenantId, id, msg.author, msg.body, at(mins - messages.length + i)],
    );
    messageIds.push(r.rows[0].id as string);
  }
  return { id, messageIds };
}

const search = (tenantId: string, q: string, opts: { cursor?: string; limit?: number } = {}) =>
  withTenant(tdb.zone('dashboard'), tenantId, (tx) =>
    searchConversations(tx, tenantId, { q, limit: opts.limit ?? 25, cursor: opts.cursor }),
  );
const ids = async (tenantId: string, q: string) =>
  (await search(tenantId, q)).results.map((r) => r.conversation.id);

const fx: Record<string, { id: string; messageIds: string[] }> = {};

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  fx.visitor = await conv(TENANT_A, 10, [
    { author: 'visitor', body: 'Hi, I want a Chocolate cake for Saturday' },
    { author: 'agent', body: 'Sure, our chocolate cake is $48.' },
  ]);
  fx.staff = await conv(TENANT_A, 20, [
    { author: 'visitor', body: 'Order KB-1042 please' },
    { author: 'staff', body: 'Your order kb-1042 is ready for pickup' },
  ]);
  fx.closed = await conv(
    TENANT_A,
    5,
    [{ author: 'visitor', body: 'My email is jane.tan@example.com, phone +65 9123 4567' }],
    true,
  );
  fx.phone1 = await conv(TENANT_A, 30, [{ author: 'visitor', body: 'call me at 91234567' }]);
  fx.phone2 = await conv(TENANT_A, 31, [{ author: 'visitor', body: 'or 9123-4567 after 6' }]);
  fx.percent = await conv(TENANT_A, 40, [{ author: 'visitor', body: 'Is it 50% off today?' }]);
  fx.percentNot = await conv(TENANT_A, 41, [{ author: 'visitor', body: 'Is it 500 off today?' }]);
  // AC-6: an unescaped `\b` would match a plain "ab"; only the literal backslash may match.
  fx.backslash = await conv(TENANT_A, 42, [{ author: 'visitor', body: 'see folder a\\b please' }]);
  fx.backslashNot = await conv(TENANT_A, 43, [{ author: 'visitor', body: 'a drab colour' }]);
  fx.chinese = await conv(TENANT_A, 50, [
    { author: 'visitor', body: '您好，我是陈美玲，想订蛋糕' },
  ]);
  fx.nric = await conv(TENANT_A, 60, [{ author: 'visitor', body: 'my id is [NRIC ••••567D]' }]);
  // Tenant B: the same needles, never visible to tenant A, and the reverse.
  fx.b = await conv(TENANT_B, 70, [
    { author: 'visitor', body: 'Chocolate cake and jane.tan@example.com 91234567 陈美玲 bonjourB' },
  ]);
  fx.onlyA = await conv(TENANT_A, 71, [{ author: 'visitor', body: 'bonjourA only here' }]);
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('searchConversations (AC-1)', () => {
  it('finds substrings case-insensitively in visitor, agent and staff messages', async () => {
    expect(await ids(TENANT_A, 'CHOCOLATE')).toEqual([fx.visitor!.id]);
    expect(await ids(TENANT_A, 'kb-1042')).toEqual([fx.staff!.id]);
    expect(await ids(TENANT_A, 'hocola')).toEqual([fx.visitor!.id]);
  });

  it('chooses the latest matching message and marks its hits', async () => {
    const [r] = (await search(TENANT_A, 'chocolate')).results;
    expect(r!.match).toMatchObject({
      messageId: fx.visitor!.messageIds[1],
      author: 'agent',
      excerpt: 'Sure, our chocolate cake is $48.',
      ranges: [{ start: 10, end: 19 }],
    });
    expect(r!.conversation).toMatchObject({ id: fx.visitor!.id, status: 'ai', owner: null });
    const [s] = (await search(TENANT_A, 'KB-1042')).results;
    expect(s!.match.author).toBe('staff');
    expect(s!.match.at).toBe(at(19));
  });

  it('includes closed conversations', async () => {
    const [r] = (await search(TENANT_A, 'jane.tan')).results;
    expect(r!.conversation).toMatchObject({ id: fx.closed!.id, status: 'closed' });
  });
});

describe('matching rules (AC-2, AC-6)', () => {
  it('finds an email by a part of it', async () => {
    expect(await ids(TENANT_A, 'jane.tan@example.com')).toEqual([fx.closed!.id]);
    expect(await ids(TENANT_A, '@EXAMPLE.COM')).toEqual([fx.closed!.id]);
  });

  it('finds an SG phone from any spelling', async () => {
    const expected = [fx.phone2!.id, fx.phone1!.id, fx.closed!.id];
    for (const q of ['91234567', '9123 4567', '9123-4567', '+65 9123 4567'])
      expect(await ids(TENANT_A, q), q).toEqual(expected);
  });

  it('matches %, _ and \\ literally', async () => {
    expect(await ids(TENANT_A, '50%')).toEqual([fx.percent!.id]);
    expect(await ids(TENANT_A, 'it_5')).toEqual([]);
    expect(await ids(TENANT_A, 'a\\b')).toEqual([fx.backslash!.id]);
  });

  it('finds a Chinese name and an NRIC by its masked token', async () => {
    expect(await ids(TENANT_A, '美玲')).toEqual([fx.chinese!.id]);
    expect(await ids(TENANT_A, 'S1234567D')).toEqual([fx.nric!.id]);
  });

  it('refuses a query under 2 characters after masking, and a bad cursor', async () => {
    await expect(search(TENANT_A, ' x ')).rejects.toBeInstanceOf(QueryTooShortError);
    await expect(search(TENANT_A, 'cake', { cursor: 'nope' })).rejects.toBeInstanceOf(
      BadCursorError,
    );
  });
});

describe('paging (AC-1)', () => {
  it('pages newest activity first, with no duplicates or gaps', async () => {
    const many: string[] = [];
    for (let i = 0; i < 7; i++)
      many.push(
        (
          await conv(TENANT_A, 100 + Math.floor(i / 2), [
            { author: 'visitor', body: `pagetoken ${i}` },
          ])
        ).id,
      );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await search(TENANT_A, 'PageToken', { limit: 3, cursor });
      seen.push(...page.results.map((r) => r.conversation.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const { rows } = await owner.query(
      `select id from conversations where id = any($1::uuid[]) order by last_message_at desc, id desc`,
      [many],
    );
    expect(seen).toEqual(rows.map((r) => r.id));
  });
});

describe('tenant isolation (AC-3)', () => {
  it("tenant B never sees tenant A's conversations, and the reverse", async () => {
    expect(await ids(TENANT_B, 'bonjourA')).toEqual([]);
    expect(await ids(TENANT_A, 'bonjourB')).toEqual([]);
    for (const q of ['chocolate', 'jane.tan', '91234567', '陈美玲'])
      expect(await ids(TENANT_B, q), q).toEqual([fx.b!.id]);
  });
});
