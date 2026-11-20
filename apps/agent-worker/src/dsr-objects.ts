import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import type { DsrObjectStore } from '@kaki/governance';

/**
 * The attachments bucket for the `dsr_objects` job (FEAT-061 §5.6): batch deletes of up to
 * 1,000 keys. S3 answers a missing key as deleted, so a re-run succeeds; any other per-key
 * error throws, and the queue retries the job.
 */
export function s3DsrObjectStore(cfg: {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
}): DsrObjectStore {
  const s3 = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
  });
  return {
    async deleteKeys(keys) {
      if (keys.length === 0) return;
      const out = await s3.send(
        new DeleteObjectsCommand({
          Bucket: cfg.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const failed = (out.Errors ?? []).filter((e) => e.Code !== 'NoSuchKey');
      if (failed.length)
        throw new Error(`dsr objects: ${failed.length} keys not deleted (${failed[0]!.Code})`);
    },
  };
}
