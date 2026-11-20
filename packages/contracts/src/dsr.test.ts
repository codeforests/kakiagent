import { describe, expect, it } from 'vitest';
import {
  DsrCorrectionBody,
  DsrCreateBody,
  DsrEraseBody,
  DsrRequester,
  DsrSelection,
  sgToday,
} from './index.js';

const id = '8d0f6a3e-4b7a-4c1e-9f0a-2b3c4d5e6f70';

describe('data-subject request contracts (FEAT-061 §3)', () => {
  it('normalises the requester and needs one identifier', () => {
    expect(
      DsrRequester.parse({ name: ' Mei ', email: ' Mei@Example.COM ', phone: '9123 4567' }),
    ).toEqual({ name: 'Mei', email: 'mei@example.com', phone: '+6591234567' });
    expect(DsrRequester.parse({ telegramId: '123456789' })).toEqual({ telegramId: '123456789' });
    const none = DsrRequester.safeParse({ name: 'Mei', email: '' });
    expect(none.success).toBe(false);
    expect(none.error?.issues[0]?.message).toBe('identifier_required');
    expect(DsrRequester.safeParse({ phone: '1234' }).success).toBe(false);
    expect(DsrRequester.safeParse({ telegramId: '@mei' }).success).toBe(false);
  });

  it('refuses a received date in the future and takes today', () => {
    const base = { type: 'deletion', requester: { email: 'a@b.co' } };
    expect(DsrCreateBody.safeParse({ ...base, receivedOn: sgToday() }).success).toBe(true);
    const future = DsrCreateBody.safeParse({ ...base, receivedOn: '2999-01-01' });
    expect(future.success).toBe(false);
    expect(future.error?.issues[0]?.message).toBe('future_date');
    expect(DsrCreateBody.safeParse({ ...base, receivedOn: '2026-02-30' }).success).toBe(false);
    expect(DsrCreateBody.safeParse({ ...base, type: 'erase', receivedOn: sgToday() }).success).toBe(
      false,
    );
  });

  it('computes the Singapore date across midnight UTC', () => {
    expect(sgToday(new Date('2026-11-20T15:59:00Z'))).toBe('2026-11-20');
    expect(sgToday(new Date('2026-11-20T16:00:00Z'))).toBe('2026-11-21');
  });

  it('caps the selection and defaults its lists', () => {
    expect(DsrSelection.parse({})).toEqual({
      contactIds: [],
      conversationIds: [],
      factIds: [],
      stagedFactIds: [],
    });
    expect(DsrSelection.safeParse({ contactIds: Array(21).fill(id) }).success).toBe(false);
    expect(DsrSelection.safeParse({ conversationIds: Array(501).fill(id) }).success).toBe(false);
    expect(DsrSelection.safeParse({ factIds: Array(101).fill(id) }).success).toBe(false);
  });

  it('erase needs the typed confirmation', () => {
    expect(DsrEraseBody.safeParse({ version: 1, selection: {}, confirm: 'delete' }).success).toBe(
      true,
    );
    expect(DsrEraseBody.safeParse({ version: 1, selection: {}, confirm: 'Delete' }).success).toBe(
      false,
    );
  });

  it('a correction changes at least one field and normalises the values', () => {
    expect(
      DsrCorrectionBody.parse({
        version: 2,
        contactId: id,
        contact: { email: 'New@Example.com', phone: '', name: null },
      }).contact,
    ).toEqual({ email: 'new@example.com', phone: null, name: null });
    expect(DsrCorrectionBody.safeParse({ version: 2, contactId: id }).success).toBe(false);
    expect(DsrCorrectionBody.safeParse({ version: 2, contactId: id, lead: { id } }).success).toBe(
      false,
    );
    expect(
      DsrCorrectionBody.safeParse({ version: 2, contactId: id, lead: { id, need: 'Cakes' } })
        .success,
    ).toBe(true);
  });
});
