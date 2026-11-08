import type { EmailChannelResponse, EmailDomainRecord } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import {
  addressError,
  domainErrorText,
  domainMeta,
  domainOf,
  domainStateChip,
  ignoredLines,
  recordStatusText,
  replyCapError,
  shownRecords,
} from './email-channel.ts';

type Domain = NonNullable<EmailChannelResponse['domain']>;
const domain = (patch: Partial<Domain>): Domain => ({
  address: 'hello@kakibakery.sg',
  domain: 'kakibakery.sg',
  state: 'pending',
  checkedAt: null,
  verifiedAt: null,
  failingSince: null,
  records: [],
  ...patch,
});
const record = (patch: Partial<EmailDomainRecord>): EmailDomainRecord => ({
  purpose: 'dkim',
  type: 'CNAME',
  host: 'a._domainkey.kakibakery.sg',
  value: 'a.dkim.amazonses.com',
  status: 'pending',
  ...patch,
});

describe('replyCapError', () => {
  it('takes whole numbers from 1 to 50', () => {
    expect(replyCapError('1')).toBeNull();
    expect(replyCapError(' 50 ')).toBeNull();
    for (const bad of ['0', '51', '', '2.5', '-1', 'ten'])
      expect(replyCapError(bad)).toBe('Enter a number from 1 to 50.');
  });
});

describe('address and domain errors', () => {
  it('checks the address shape and reads its domain', () => {
    expect(addressError('hello@kakibakery.sg')).toBeNull();
    expect(addressError('kakibakery.sg')).toBe(
      'Enter an email address like hello@yourbusiness.sg.',
    );
    expect(domainOf('Hello@GMail.com')).toBe('gmail.com');
  });

  it('maps the API codes to the ui-design copy', () => {
    const err = (code: string, status = 422) => new ApiError(status, code, code);
    expect(domainErrorText(err('platform_domain'), 'me@gmail.com')).toBe(
      'Use an address on your own domain, not gmail.com.',
    );
    expect(domainErrorText(err('provider_unavailable', 502), 'a@b.sg')).toBe(
      "We couldn't reach our email provider. Try again in a minute.",
    );
    expect(domainErrorText(err('invalid_body'), 'x')).toBe(
      'Enter an email address like hello@yourbusiness.sg.',
    );
    expect(domainErrorText(err('stale', 409), 'a@b.sg')).toBeNull();
    expect(domainErrorText(new TypeError('offline'), 'a@b.sg')).toMatch(/connection/);
  });
});

describe('chips and meta', () => {
  it('always gives text with the icon', () => {
    expect(recordStatusText('ok')).toEqual({ tone: 'success', icon: 'check', text: 'OK' });
    expect(recordStatusText('pending').text).toBe('Waiting');
    expect(recordStatusText('failing')).toEqual({ tone: 'danger', icon: 'x', text: 'Not found' });
    expect(domainStateChip('pending').text).toBe('Checking DNS');
    expect(domainStateChip('verified').text).toBe('Verified');
    expect(domainStateChip('failing')).toMatchObject({ tone: 'warning', text: 'Not working' });
  });

  it('says when the domain was checked, verified or broke', () => {
    const now = new Date('2026-11-08T06:10:00Z');
    expect(domainMeta(domain({}), now)).toBe('Not checked yet');
    expect(domainMeta(domain({ checkedAt: '2026-11-08T06:05:00Z' }), now)).toBe(
      'Last checked 5 minutes ago',
    );
    expect(domainMeta(domain({ state: 'verified', verifiedAt: '2026-10-27T06:05:00Z' }), now)).toBe(
      'Verified 27 Oct 2026, 2:05 pm',
    );
    expect(
      domainMeta(domain({ state: 'failing', failingSince: '2026-10-27T06:05:00Z' }), now),
    ).toBe('Not working since 27 Oct 2026, 2:05 pm');
  });
});

describe('ignoredLines', () => {
  it('lists non-zero reasons in order, singular for one, echo folded into loops', () => {
    expect(ignoredLines([])).toEqual([]);
    expect(
      ignoredLines([
        { reason: 'spam', count: 2 },
        { reason: 'auto_reply', count: 1 },
        { reason: 'echo', count: 1 },
        { reason: 'loop', count: 2 },
        { reason: 'list', count: 4 },
      ]),
    ).toEqual(['1 out-of-office reply', '4 mailing-list emails', '2 spam', '3 loops']);
  });
});

describe('shownRecords', () => {
  it('hides the DMARC row once it is there', () => {
    const dkim = record({});
    const dmarc = record({ purpose: 'dmarc', type: 'TXT', host: '_dmarc.kakibakery.sg' });
    expect(shownRecords([dkim, dmarc])).toEqual([dkim, dmarc]);
    expect(shownRecords([dkim, { ...dmarc, status: 'ok' }])).toEqual([dkim]);
  });
});
