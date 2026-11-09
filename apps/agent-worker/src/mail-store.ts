import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { MailObjectStore } from '@kaki/channels';

/** The inbound-mail and quarantine buckets (FEAT-036 §5.2) on S3, LocalStack locally. */
export function s3MailStore(cfg: {
  quarantineBucket: string;
  region: string;
  endpoint?: string | undefined;
}): MailObjectStore {
  const s3 = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
  });
  return {
    async getRaw(bucket, key) {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!out.Body) throw new Error('empty inbound mail object');
      return out.Body.transformToByteArray();
    },
    async deleteRaw(bucket, key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async putQuarantine(key, bytes, contentType) {
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.quarantineBucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
        }),
      );
    },
  };
}
