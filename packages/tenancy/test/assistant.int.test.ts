/**
 * Assistant settings (FEAT-024 §5.1; AC-1, AC-9, AC-10): saved by version on the
 * dashboard zone, audited without text, and read by the visitor zone through
 * `visitorTenantState`.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSONA,
  getAssistantSettings,
  saveAssistantSettings,
  SettingsConflictError,
  visitorTenantState,
  type Persona,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = 'user-owner-1';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);

const PERSONA: Persona = {
  botName: 'Kaki',
  tone: 'professional',
  emoji: true,
  greeting: { en: 'Hello! Ask me about our cakes.', zh: null },
  disclosureNote: { en: 'Our team reads every conversation.', zh: '我们的团队会阅读每条对话。' },
  afterHoursMessage: { en: null, zh: null },
  fallbackMessage: { en: 'We will reply within a day.', zh: null },
};

const save = (tenantId: string, version: number, persona: Persona) =>
  dash(tenantId, (tx) => saveAssistantSettings(tx, { tenantId, userId: USER, version, persona }));

const auditRows = async (tenantId: string) =>
  (
    await owner.query(
      `select event_type, actor_ref, payload from audit_entries
       where tenant_id = $1 and event_type = 'settings.assistant_updated' order by seq`,
      [tenantId],
    )
  ).rows;

describe('assistant settings (FEAT-024)', () => {
  it('reads the defaults when nothing was saved', async () => {
    expect(await dash(TENANT_B, (tx) => getAssistantSettings(tx, TENANT_B))).toEqual(
      DEFAULT_PERSONA,
    );
    const v = await withTenant(tdb.zone('visitor'), TENANT_B, (tx) => visitorTenantState(tx));
    const { version: _v, updatedAt: _u, ...persona } = DEFAULT_PERSONA;
    expect(v?.persona).toEqual(persona);
  });

  it('a first save creates version 1, a later save bumps it, and both are audited without text', async () => {
    const first = await save(TENANT_A, 0, PERSONA);
    expect(first).toMatchObject({ ...PERSONA, version: 1 });
    expect(first.updatedAt).toBeInstanceOf(Date);
    const second = await save(TENANT_A, 1, { ...PERSONA, tone: 'friendly', emoji: false });
    expect(second).toMatchObject({ version: 2, tone: 'friendly', emoji: false, botName: 'Kaki' });
    expect(await dash(TENANT_A, (tx) => getAssistantSettings(tx, TENANT_A))).toEqual(second);

    const rows = await auditRows(TENANT_A);
    expect(rows).toEqual([
      {
        event_type: 'settings.assistant_updated',
        actor_ref: USER,
        payload: {
          version: 1,
          fields: ['bot_name', 'tone', 'emoji', 'greeting', 'disclosure_note', 'fallback_message'],
        },
      },
      {
        event_type: 'settings.assistant_updated',
        actor_ref: USER,
        payload: { version: 2, fields: ['tone', 'emoji'] },
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/Kaki|cakes|team|团队|reply/);
  });

  it('the visitor zone reads the saved persona for its own tenant only', async () => {
    const a = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) => visitorTenantState(tx));
    expect(a?.persona).toMatchObject({
      botName: 'Kaki',
      tone: 'friendly',
      disclosureNote: PERSONA.disclosureNote,
      fallbackMessage: PERSONA.fallbackMessage,
    });
    const b = await withTenant(tdb.zone('visitor'), TENANT_B, (tx) => visitorTenantState(tx));
    expect(b?.persona.botName).toBeNull();
  });

  it('a stale version or a second first save conflicts and changes nothing', async () => {
    await expect(save(TENANT_A, 1, { ...PERSONA, botName: 'Stale' })).rejects.toThrow(
      SettingsConflictError,
    );
    await expect(save(TENANT_A, 0, { ...PERSONA, botName: 'Racer' })).rejects.toThrow(
      SettingsConflictError,
    );
    const now = await dash(TENANT_A, (tx) => getAssistantSettings(tx, TENANT_A));
    expect(now).toMatchObject({ version: 2, botName: 'Kaki' });
    expect(await auditRows(TENANT_A)).toHaveLength(2);
  });
});
