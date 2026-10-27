/**
 * Privacy wordings (FEAT-058 §5.1; AC-3, AC-4, AC-5, AC-8): immutable numbered wordings,
 * optimistic saves, audit without text, readiness, and the visitor read.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CONSENT_PROMPT,
  DEFAULT_PURPOSE,
  getPrivacySettings,
  PRIVACY_TEMPLATE_VERSION,
  PrivacyConflictError,
  privacyNoticeUrl,
  privacyReadiness,
  savePrivacyNotice,
  savePurposeStatement,
  visitorPrivacy,
  type NoticeInput,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userA: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  userA = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)).rows[0]
    .id;
});
afterEach(async () => {
  await owner.query(`delete from privacy_settings`);
  await owner.query(`delete from wording_versions`);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(tdb.zone('dashboard'), tenantId, fn);
const LINK: NoticeInput = { mode: 'link', url: 'https://kakibakery.test/privacy' };
const TEMPLATE: NoticeInput = {
  mode: 'template',
  fields: {
    contactName: 'Mei Lin',
    contactEmail: 'dpo@kakibakery.test',
    contactPhone: '',
    address: null,
    extra: null,
  },
};
const notice = (version: number, n: NoticeInput, tenantId = TENANT_A) =>
  dash(tenantId, (tx) => savePrivacyNotice(tx, { tenantId, userId: userA, version, notice: n }));
const purpose = (version: number, en: string, zh: string | null = null) =>
  dash(TENANT_A, (tx) =>
    savePurposeStatement(tx, {
      tenantId: TENANT_A,
      userId: userA,
      version,
      purpose: { en, zh },
    }),
  );
const wordings = async () =>
  (
    await owner.query(
      `select kind, seq, content from wording_versions where tenant_id = $1 order by kind, seq`,
      [TENANT_A],
    )
  ).rows;

describe('privacy wordings (FEAT-058)', () => {
  it('reads defaults when nothing was saved', async () => {
    const s = await dash(TENANT_A, (tx) => getPrivacySettings(tx, TENANT_A));
    expect(s).toEqual({
      version: 0,
      notice: { mode: 'none' },
      purpose: { text: { ...DEFAULT_PURPOSE }, wording: null },
    });
  });

  it('numbers each changed save, moves the pointer, and skips identical content', async () => {
    const first = await notice(0, LINK);
    expect(first.version).toBe(1);
    expect(first.notice).toMatchObject({ mode: 'link', url: LINK.url, wording: { seq: 1 } });
    const second = await notice(1, TEMPLATE);
    expect(second.version).toBe(2);
    expect(second.notice).toMatchObject({
      mode: 'template',
      templateVersion: PRIVACY_TEMPLATE_VERSION,
      fields: { contactName: 'Mei Lin', contactPhone: null },
      wording: { seq: 2 },
    });
    const same = await notice(2, TEMPLATE);
    expect(same.version).toBe(2);
    expect((await wordings()).map((w) => w.seq)).toEqual([1, 2]);
    // The first wording is unchanged.
    expect((await wordings())[0].content).toEqual({ mode: 'link', url: LINK.url });
  });

  it('a stale version is a conflict and leaves no new wording', async () => {
    await notice(0, LINK);
    await expect(notice(0, TEMPLATE)).rejects.toBeInstanceOf(PrivacyConflictError);
    await expect(purpose(0, 'Something else.')).rejects.toBeInstanceOf(PrivacyConflictError);
    expect(await wordings()).toHaveLength(1);
  });

  it('a purpose wording holds the purpose and the consent prompt in both languages', async () => {
    const s = await purpose(0, 'To reply to you.', '为了回复您。');
    expect(s.purpose).toMatchObject({
      text: { en: 'To reply to you.', zh: '为了回复您。' },
      wording: { seq: 1 },
    });
    const [w] = await wordings();
    expect(w.kind).toBe('purpose_statement');
    expect(w.content).toMatchObject({
      purpose: { en: 'To reply to you.', zh: '为了回复您。' },
      consentPrompt: CONSENT_PROMPT,
    });
  });

  it('audits version, seq and mode only', async () => {
    await notice(0, TEMPLATE);
    await purpose(1, 'To reply to you.');
    const rows = (
      await owner.query(
        `select event_type, payload::text as p from audit_entries
         where tenant_id = $1 and event_type like 'settings.%_updated' and event_type <> 'settings.assistant_updated' order by seq desc limit 2`,
        [TENANT_A],
      )
    ).rows.reverse();
    expect(rows.map((r) => r.event_type)).toEqual([
      'settings.privacy_notice_updated',
      'settings.purpose_statement_updated',
    ]);
    expect(JSON.parse(rows[0].p)).toEqual({ version: 1, seq: 1, mode: 'template' });
    expect(JSON.parse(rows[1].p)).toEqual({ version: 2, seq: 1 });
    for (const r of rows) expect(r.p).not.toMatch(/Mei|dpo@|reply/);
  });

  it('readiness needs an explicit save of each', async () => {
    const ready = () => dash(TENANT_A, (tx) => privacyReadiness(tx, TENANT_A));
    expect(await ready()).toEqual({ privacyNotice: false, purposeStatement: false });
    await notice(0, LINK);
    expect(await ready()).toEqual({ privacyNotice: true, purposeStatement: false });
    await purpose(1, DEFAULT_PURPOSE.en, DEFAULT_PURPOSE.zh);
    expect(await ready()).toEqual({ privacyNotice: true, purposeStatement: true });
  });

  it("the visitor zone reads the current tenant's wordings only", async () => {
    await notice(0, TEMPLATE);
    const a = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) => visitorPrivacy(tx));
    expect(a?.notice).toMatchObject({ mode: 'template', fields: { contactName: 'Mei Lin' } });
    expect(a?.businessName).toBeTruthy();
    expect(privacyNoticeUrl(a!.notice, 'wk_abc', 'https://api.test/')).toBe(
      'https://api.test/privacy/wk_abc',
    );
    const b = await withTenant(tdb.zone('visitor'), TENANT_B, (tx) => visitorPrivacy(tx));
    expect(b?.notice).toBeNull();
    expect(privacyNoticeUrl(b!.notice, 'wk_b', 'https://api.test')).toBeNull();
    const bs = await dash(TENANT_B, (tx) => getPrivacySettings(tx, TENANT_B));
    expect(bs.notice).toEqual({ mode: 'none' });
  });
});
