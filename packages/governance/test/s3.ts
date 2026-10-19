import {
  CreateBucketCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { randomUUID } from 'node:crypto';

export interface TestS3 {
  endpoint: string;
  region: string;
  s3: S3Client;
  /** Creates a bucket with Object Lock and a 1-day compliance default, as LocalStack init does. */
  lockedBucket(): Promise<string>;
  stop(): Promise<void>;
}

/**
 * LocalStack in a container (as CI runs it), or, without Docker, any S3-compatible
 * endpoint with Object Lock support given in `KAKI_TEST_S3_ENDPOINT`, like
 * `KAKI_TEST_DATABASE_URL` for Postgres (design D10).
 */
export async function startTestS3(): Promise<TestS3> {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  const region = 'ap-southeast-1';
  let container: StartedLocalStackContainer | null = null;
  let endpoint = process.env.KAKI_TEST_S3_ENDPOINT;
  if (!endpoint) {
    container = await new LocalstackContainer('localstack/localstack:4')
      .withEnvironment({ SERVICES: 's3' })
      .start();
    endpoint = container.getConnectionUri();
  }
  const s3 = new S3Client({ region, endpoint, forcePathStyle: true });
  return {
    endpoint,
    region,
    s3,
    async lockedBucket() {
      const bucket = `audit-anchors-${randomUUID().slice(0, 8)}`;
      await s3.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ObjectLockEnabledForBucket: true,
          CreateBucketConfiguration: { LocationConstraint: region },
        }),
      );
      await s3.send(
        new PutObjectLockConfigurationCommand({
          Bucket: bucket,
          ObjectLockConfiguration: {
            ObjectLockEnabled: 'Enabled',
            Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 1 } },
          },
        }),
      );
      return bucket;
    },
    async stop() {
      s3.destroy();
      if (container) await container.stop();
    },
  };
}
