import { GetObjectTaggingCommand } from '@aws-sdk/client-s3';
import { ScannerUnavailableError } from '@kaki/kb';
import { describe, expect, it } from 'vitest';
import { guarddutyScanner, SCAN_TAG } from './guardduty.js';

/** A fake S3 client answering GetObjectTagging with each tag set in turn. */
function fakeS3(...answers: (string | undefined | Error)[]) {
  const calls: GetObjectTaggingCommand[] = [];
  return {
    calls,
    send: (async (cmd: GetObjectTaggingCommand) => {
      calls.push(cmd);
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return {
        TagSet: a === undefined ? [{ Key: 'other', Value: 'x' }] : [{ Key: SCAN_TAG, Value: a }],
      };
    }) as never,
  };
}
const file = { key: 'uploads/t/u', bytes: new Uint8Array() };
const scanner = (s3: ReturnType<typeof fakeS3>, timeoutMs = 50) =>
  guarddutyScanner({ s3, quarantineBucket: 'q', pollMs: 5, timeoutMs });

describe('guarddutyScanner', () => {
  it('is clean only for NO_THREATS_FOUND, on the quarantine object', async () => {
    const s3 = fakeS3('NO_THREATS_FOUND');
    await expect(scanner(s3).scan(file)).resolves.toEqual({ infected: false });
    expect(s3.calls[0]!.input).toEqual({ Bucket: 'q', Key: 'uploads/t/u' });
  });

  it('is infected for THREATS_FOUND', async () => {
    await expect(scanner(fakeS3('THREATS_FOUND')).scan(file)).resolves.toMatchObject({
      infected: true,
    });
  });

  it.each(['UNSUPPORTED', 'ACCESS_DENIED', 'FAILED', 'SOMETHING_NEW'])(
    'has no verdict for %s',
    async (status) => {
      await expect(scanner(fakeS3(status)).scan(file)).rejects.toThrow(ScannerUnavailableError);
    },
  );

  it('waits for the tag, then reads it', async () => {
    const s3 = fakeS3(undefined, undefined, 'NO_THREATS_FOUND');
    await expect(scanner(s3, 1000).scan(file)).resolves.toEqual({ infected: false });
    expect(s3.calls).toHaveLength(3);
  });

  it('never treats a missing tag as clean', async () => {
    const s3 = fakeS3(undefined);
    await expect(scanner(s3).scan(file)).rejects.toThrow(ScannerUnavailableError);
    expect(s3.calls.length).toBeGreaterThan(1);
  });

  it('has no verdict when S3 fails', async () => {
    await expect(scanner(fakeS3(new Error('throttled'))).scan(file)).rejects.toThrow(
      ScannerUnavailableError,
    );
  });
});
