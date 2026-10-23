import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { Bucket, FileStore } from '@kaki/kb';

const notFound = (err: unknown) =>
  err instanceof S3ServiceException &&
  (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404);

/**
 * The quarantine and sources buckets (ADR-018 d2, FEAT-015 §5.1) on S3, LocalStack
 * locally through `endpoint`.
 */
export function s3FileStore(cfg: {
  quarantineBucket: string;
  sourcesBucket: string;
  region: string;
  endpoint?: string | undefined;
  client?: S3Client;
}): FileStore & { s3: S3Client } {
  const s3 =
    cfg.client ??
    new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    });
  const name = (b: Bucket) => (b === 'quarantine' ? cfg.quarantineBucket : cfg.sourcesBucket);
  return {
    s3,
    async head(bucket, key) {
      try {
        const out = await s3.send(new HeadObjectCommand({ Bucket: name(bucket), Key: key }));
        return { size: out.ContentLength ?? 0 };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    async get(bucket, key) {
      const out = await s3.send(new GetObjectCommand({ Bucket: name(bucket), Key: key }));
      if (!out.Body) throw new Error('empty object body');
      return out.Body.transformToByteArray();
    },
    async copyToSources(fromKey, toKey) {
      await s3.send(
        new CopyObjectCommand({
          Bucket: cfg.sourcesBucket,
          Key: toKey,
          CopySource: `${cfg.quarantineBucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
          // The browser's Content-Type isn't trusted; the sniffed type is in the database.
          MetadataDirective: 'REPLACE',
          ContentType: 'application/octet-stream',
          // GuardDuty's scan tag stays on the quarantine object (no tagging on sources).
          TaggingDirective: 'REPLACE',
        }),
      );
    },
    async delete(bucket, key) {
      // S3 answers 204 for a missing key too, so a second purge is a no-op.
      await s3.send(new DeleteObjectCommand({ Bucket: name(bucket), Key: key }));
    },
  };
}
