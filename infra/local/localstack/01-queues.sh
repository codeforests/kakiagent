#!/bin/sh
# Creates the walking skeleton's queues in LocalStack (ADR-012), mirroring
# infra/terraform/modules/queues: a FIFO turns queue with a DLQ after 5 receives.
set -eu
awslocal sqs create-queue --queue-name conversation-turns-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name conversation-turns-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sqs create-queue --queue-name conversation-turns.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"60\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null
echo "localstack: queues ready"
