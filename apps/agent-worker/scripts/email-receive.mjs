#!/usr/bin/env node
/**
 * `pnpm email:receive <file.eml> [--to <local part>]` (FEAT-036 §5.6): does locally what SES
 * does in AWS. Puts the file in the inbound-mail bucket and an SES-shaped SNS notification on
 * the `email-inbound` queue, which the agent-worker consumes. Local and E2E only.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const toAt = args.indexOf('--to');
const local = toAt >= 0 ? args[toAt + 1] : 'kaki-bakery';
const verdictAt = args.indexOf('--spam');
if (!file) {
  console.error('usage: pnpm email:receive <file.eml> [--to <local part>] [--spam FAIL]');
  process.exit(2);
}
const env = process.env;
const region = env.AWS_REGION ?? 'ap-southeast-1';
const endpoint = env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const bucket = env.EMAIL_INBOUND_BUCKET ?? 'kaki-local-inbound-mail';
const domain = env.EMAIL_INBOUND_DOMAIN ?? 'in.kaki.test';
const topic = env.EMAIL_SNS_TOPIC_ARN ?? 'arn:aws:sns:ap-southeast-1:000000000000:email-inbound';
const queueUrl =
  env.SQS_EMAIL_INBOUND_QUEUE_URL ??
  'http://sqs.ap-southeast-1.localhost.localstack.cloud:4566/000000000000/email-inbound';
const credentials = {
  accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
  secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
};

const raw = readFileSync(resolve(env.INIT_CWD ?? process.cwd(), file));
const sesId = randomUUID().replace(/-/g, '');
const key = `inbound-mail/${sesId}`;
await new S3Client({ region, endpoint, forcePathStyle: true, credentials }).send(
  new PutObjectCommand({ Bucket: bucket, Key: key, Body: raw }),
);
const status = (s) => ({ status: s });
const message = {
  notificationType: 'Received',
  mail: { messageId: sesId, destination: [`${local}@${domain}`] },
  receipt: {
    recipients: [`${local}@${domain}`],
    spamVerdict: status(verdictAt >= 0 ? args[verdictAt + 1] : 'PASS'),
    virusVerdict: status('PASS'),
    dmarcVerdict: status('PASS'),
    action: { type: 'S3', bucketName: bucket, objectKey: key },
  },
};
await new SQSClient({ region, endpoint, credentials }).send(
  new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({
      Type: 'Notification',
      MessageId: randomUUID(),
      TopicArn: topic,
      Message: JSON.stringify(message),
      Timestamp: new Date().toISOString(),
    }),
  }),
);
console.log(`queued ${file} for ${local}@${domain} (SES id ${sesId})`);
