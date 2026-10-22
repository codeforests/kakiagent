import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { context, propagation } from '@opentelemetry/api';

export interface QueueMessage<T> {
  /** Outbox row ID: the idempotency key every consumer dedupes on (ADR-012). */
  id: string;
  body: T;
  receiveCount: number;
}

export interface ConsumeOptions {
  queueUrl: string;
  signal: AbortSignal;
  waitTimeSeconds?: number;
  /** Messages per receive (1–10, default 10); long jobs take 1 so none waits past its visibility. */
  maxMessages?: number;
  onError?: (err: unknown, raw: Message) => void;
}

export interface QueueClient {
  send(queueUrl: string, msg: { id: string; groupId?: string; body: unknown }): Promise<void>;
  consume<T>(opts: ConsumeOptions, handler: (msg: QueueMessage<T>) => Promise<void>): Promise<void>;
  sqs: SQSClient;
}

/**
 * Thin SQS wrapper. Sends carry the outbox ID as both the FIFO deduplication ID and a
 * message attribute, and the W3C trace context so traces cross api → queue → worker.
 * A handler that throws leaves the message on the queue; SQS redrives it to the DLQ
 * after the queue's maxReceiveCount (NFR-17).
 */
export function createQueueClient(cfg: {
  region: string;
  endpoint?: string | undefined;
}): QueueClient {
  const sqs = new SQSClient({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
  });
  const isFifo = (url: string) => url.endsWith('.fifo');

  return {
    sqs,
    async send(queueUrl, msg) {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(msg.body),
          MessageAttributes: {
            outboxId: { DataType: 'String', StringValue: msg.id },
            ...(carrier.traceparent
              ? { traceparent: { DataType: 'String', StringValue: carrier.traceparent } }
              : {}),
          },
          ...(isFifo(queueUrl)
            ? { MessageGroupId: msg.groupId ?? msg.id, MessageDeduplicationId: msg.id }
            : {}),
        }),
      );
    },
    async consume<T>(opts: ConsumeOptions, handler: (msg: QueueMessage<T>) => Promise<void>) {
      while (!opts.signal.aborted) {
        let res;
        try {
          res = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: opts.queueUrl,
              MaxNumberOfMessages: opts.maxMessages ?? 10,
              WaitTimeSeconds: opts.waitTimeSeconds ?? 10,
              MessageAttributeNames: ['All'],
              MessageSystemAttributeNames: ['ApproximateReceiveCount'],
            }),
            { abortSignal: opts.signal },
          );
        } catch (err) {
          if (opts.signal.aborted) return;
          throw err;
        }
        for (const raw of res.Messages ?? []) {
          const id = raw.MessageAttributes?.outboxId?.StringValue ?? raw.MessageId ?? '';
          const traceparent = raw.MessageAttributes?.traceparent?.StringValue;
          const ctx = traceparent
            ? propagation.extract(context.active(), { traceparent })
            : context.active();
          try {
            await context.with(ctx, () =>
              handler({
                id,
                body: JSON.parse(raw.Body ?? 'null') as T,
                receiveCount: Number(raw.Attributes?.ApproximateReceiveCount ?? '1'),
              }),
            );
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: opts.queueUrl,
                ReceiptHandle: raw.ReceiptHandle,
              }),
            );
          } catch (err) {
            opts.onError?.(err, raw);
          }
        }
      }
    },
  };
}
