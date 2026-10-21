#!/bin/sh
# Creates the queues in LocalStack (ADR-012), mirroring infra/terraform/modules/queues:
# one FIFO queue per outbox topic, each with a DLQ. conversation-turns: 60 s visibility,
# DLQ after 5 receives. ingest (FEAT-012): 1,800 s visibility, DLQ after 6 receives.
set -eu
fifo_queue() {
  name=$1 visibility=$2 receives=$3
  awslocal sqs create-queue --queue-name "${name}-dlq.fifo" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
  dlq_arn=$(awslocal sqs get-queue-attributes \
    --queue-url "$(awslocal sqs get-queue-url --queue-name "${name}-dlq.fifo" --query QueueUrl --output text)" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text)
  awslocal sqs create-queue --queue-name "${name}.fifo" \
    --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"${visibility}\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"${receives}\\\"}\"}" >/dev/null
}
fifo_queue conversation-turns 60 5
fifo_queue ingest 1800 6
echo "localstack: queues ready"
