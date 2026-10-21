/**
 * FEAT-024 through the real turn (AC-4, AC-5, AC-6, AC-9): the tenant's saved persona
 * shapes the disclosure, the fallbacks, the after-hours notice and emoji, and the
 * decision entry records only codes.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation } from '@kaki/inbox';
import { createFact, dashboardKb, prepareChunk, type FactInput } from '@kaki/kb';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  gatewayFromConfig,
  type FakeScript,
} from '@kaki/llm-gateway';
import { DEFAULT_PERSONA, saveAssistantSettings, type Persona } from '@kaki/tenancy';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeTriage, fakeVisitorResponder, runVisitorTurn, textsFor } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const embedder = gatewayFromConfig({ provider: 'fake' });

const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};

const { version: _v, updatedAt: _u, ...DEFAULTS } = DEFAULT_PERSONA;
const PERSONA: Persona = {
  ...DEFAULTS,
  botName: 'Kaki',
  disclosureNote: { en: 'Our team reads every chat.', zh: '我们的团队会阅读每条对话。' },
  fallbackMessage: { en: 'We will reply within a day.', zh: '我们会在一天内回复。' },
  afterHoursMessage: { en: 'Leave your question and we will follow up.', zh: null },
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const chunk = await prepareChunk(embedder, TENANT_A, FUDGE);
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    createFact(dashboardKb(tx, TENANT_A, 'owner-1'), FUDGE, chunk),
  );
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`update tenants set ai_paused = false`);
  await owner.query(`update business_profiles set hours = null where tenant_id = $1`, [TENANT_A]);
  await owner.query(`delete from assistant_settings`);
});

async function savePersona(persona: Persona) {
  await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    saveAssistantSettings(tx, { tenantId: TENANT_A, userId: 'owner-1', version: 0, persona }),
  );
}

async function ask(text: string, reply?: FakeScript) {
  const visitorId = randomUUID();
  const conv = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    createConversation(tx, TENANT_A, visitorId),
  );
  const { message } = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      visitorId,
      text,
      clientMessageId: randomUUID(),
    }),
  );
  const llm = createGateway(defaultRegistry('fake'), [
    createFakeProvider((req) =>
      req.model === 'triage' ? fakeTriage(req) : (reply ?? fakeVisitorResponder)(req),
    ),
  ]);
  const result = await runVisitorTurn(
    { zdb: tdb.zone('visitor'), llm },
    { tenantId: TENANT_A, conversationId: conv.id, messageId: message.id },
  );
  return result!;
}

async function decision(messageId: string) {
  const { rows } = await owner.query(
    `select payload from audit_entries
     where event_type = 'agent.decision' and split_part(subject_refs[1], ':', 2) = $1`,
    [messageId],
  );
  return rows[0].payload as Record<string, unknown>;
}

describe('the persona through the turn (FEAT-024)', () => {
  it('with no saved settings, the first reply is exactly as before', async () => {
    const r = await ask('how much is the chocolate fudge cake?');
    expect(r.message.disclosure).toBe("You're chatting with an AI assistant for Kaki Bakery.");
    expect(r.message.body).toBe('The Chocolate fudge cake (1 kg) is S$55.00.');
    expect(await decision(r.message.id)).toMatchObject({ tone: 'friendly', emojiRemoved: false });
  });

  it('names the bot and appends the note in the disclosure, in English and Chinese (AC-5)', async () => {
    await savePersona(PERSONA);
    const en = await ask('how much is the chocolate fudge cake?');
    expect(en.message.disclosure).toBe(
      "You're chatting with Kaki, an AI assistant for Kaki Bakery. Our team reads every chat.",
    );
    const zh = await ask('chocolate fudge cake 多少钱？');
    expect(zh.message.disclosure).toBe(
      '您正在与 Kaki 对话，这是 Kaki Bakery 的 AI 助手。 我们的团队会阅读每条对话。',
    );
  });

  it("uses the tenant's fallback when paused and when the model is unavailable (AC-6)", async () => {
    await savePersona(PERSONA);
    await owner.query(`update tenants set ai_paused = true where id = $1`, [TENANT_A]);
    const paused = await ask('hello?');
    expect(paused).toMatchObject({ outcome: 'paused' });
    expect(paused.message.body).toBe('We will reply within a day.');
    await owner.query(`update tenants set ai_paused = false where id = $1`, [TENANT_A]);
    const down = await ask('how much is the chocolate fudge cake?', () => {
      throw new Error('model unavailable');
    });
    expect(down.outcome).toBe('unavailable');
    expect(down.message.body).toBe('We will reply within a day.');
    const zh = await ask('你好，蛋糕多少钱？', () => {
      throw new Error('model unavailable');
    });
    expect(zh.message.body).toBe('我们会在一天内回复。');
  });

  it("keeps the return time in the after-hours notice and adds the tenant's message (AC-6)", async () => {
    await savePersona(PERSONA);
    // Closed all week: no reopening is known within the horizon.
    const empty = Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, []]),
    );
    await owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [
      TENANT_A,
      empty,
    ]);
    const r = await ask('how much is the chocolate fudge cake?');
    expect(r.afterHours).toBe(true);
    expect(r.message.notice).toBe(
      "We're closed right now, and the team will get back to you as soon as they can. Leave your question and we will follow up.",
    );
    expect(r.message.notice).toBe(textsFor('en', PERSONA).afterHours(null));
  });

  it('emoji off: model emoji never reach the stored reply, and the decision says so (AC-4, AC-9)', async () => {
    await savePersona({ ...PERSONA, emoji: false });
    const r = await ask('how much is the chocolate fudge cake?', (req) => {
      const ref = /^\[f:([0-9a-f]+)\] product/m.exec(req.tail ?? '')![1];
      return `Sure 😊 The [[f:${ref}.name]] is [[f:${ref}.price]] 🎂.`;
    });
    expect(r.message.body).toBe('Sure The Chocolate fudge cake is S$55.00.');
    const d = await decision(r.message.id);
    expect(d).toMatchObject({ tone: 'friendly', emojiRemoved: true });
    expect(JSON.stringify(d)).not.toMatch(/Kaki|team|fudge|S\$/i);
  });

  it('emoji on with a friendly tone: the fake model adds one (AC-4)', async () => {
    await savePersona({ ...PERSONA, emoji: true });
    const r = await ask('how much is the chocolate fudge cake?');
    expect(r.message.body).toBe('The Chocolate fudge cake (1 kg) is S$55.00. 🙂');
  });

  it('a professional tone is recorded as its code', async () => {
    await savePersona({ ...PERSONA, tone: 'professional' });
    const r = await ask('how much is the chocolate fudge cake?');
    expect(await decision(r.message.id)).toMatchObject({ tone: 'professional' });
  });
});
