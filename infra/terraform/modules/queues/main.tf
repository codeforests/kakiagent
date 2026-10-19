# SQS FIFO queues with DLQs (ADR-012). The skeleton has one topic; features add more
# by extending var.queues. Mirrors infra/local/localstack/01-queues.sh.

resource "aws_sqs_queue" "dlq" {
  for_each                  = var.queues
  name                      = "${var.name}-${each.key}-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "this" {
  for_each                   = var.queues
  name                       = "${var.name}-${each.key}.fifo"
  fifo_queue                 = true
  deduplication_scope        = "messageGroup"
  fifo_throughput_limit      = "perMessageGroupId"
  visibility_timeout_seconds = each.value.visibility_timeout_seconds
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = each.value.max_receive_count
  })
}
