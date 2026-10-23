import { GetObjectTaggingCommand, type S3Client } from '@aws-sdk/client-s3';
import { ScannerUnavailableError, type MalwareScanner } from '@kaki/kb';
import { setTimeout as sleep } from 'node:timers/promises';

export const SCAN_TAG = 'GuardDutyMalwareScanStatus';

/**
 * GuardDuty Malware Protection for S3 (FEAT-015 §5.3, MD): GuardDuty scans each new
 * quarantine object and tags it. This reads the tag, polling every 2 s for up to 90 s.
 * Only `NO_THREATS_FOUND` is clean; `THREATS_FOUND` is infected; anything else, or no tag
 * yet, means no verdict, so the stage is retried. A missing tag is never clean.
 */
export function guarddutyScanner(cfg: {
  s3: Pick<S3Client, 'send'>;
  quarantineBucket: string;
  pollMs?: number;
  timeoutMs?: number;
}): MalwareScanner {
  const pollMs = cfg.pollMs ?? 2_000;
  const timeoutMs = cfg.timeoutMs ?? 90_000;
  return {
    async scan({ key }) {
      const deadline = Date.now() + timeoutMs;
      let status: string | undefined;
      for (;;) {
        const out = await cfg.s3
          .send(new GetObjectTaggingCommand({ Bucket: cfg.quarantineBucket, Key: key }))
          .catch((err: unknown) => {
            throw new ScannerUnavailableError('reading the scan tag failed', { cause: err });
          });
        status = out.TagSet?.find((t) => t.Key === SCAN_TAG)?.Value;
        if (status === 'NO_THREATS_FOUND') return { infected: false };
        // GuardDuty doesn't name the threat in the tag; its finding does.
        if (status === 'THREATS_FOUND') return { infected: true, signature: 'guardduty' };
        if (status !== undefined || Date.now() + pollMs > deadline) break;
        await sleep(pollMs);
      }
      throw new ScannerUnavailableError(`no scan verdict (${status ?? 'untagged'})`);
    },
  };
}
