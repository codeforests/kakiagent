# The email channel (FEAT-036 §5.6). Customers forward mail to <tenant>@in.<mail_domain>.
# SES receives it on the MX below, scans it, stores the raw message in the inbound bucket
# and publishes a notification to the topic; the topic feeds the email-inbound queue that
# the agent-worker consumes. The configuration set's bounces and complaints go to the same
# topic. Replies are sent from the same in. domain (its own DKIM and MAIL FROM).
# Written now; applied at milestone MD.

data "aws_caller_identity" "current" {}

locals {
  inbound_domain           = "in.${var.mail_domain}"
  inbound_mail_from_domain = "mail.${local.inbound_domain}"
  inbound_prefix           = "inbound/"
  inbound_mx_record        = { name = local.inbound_domain, type = "MX", value = "10 inbound-smtp.${var.region}.amazonaws.com" }
  account_id               = data.aws_caller_identity.current.account_id
  receipt_rule_set_name    = "${var.name}-inbound"
  receipt_rule_name        = "${var.name}-forwarded"
  receipt_rule_arn         = "arn:aws:ses:${var.region}:${local.account_id}:receipt-rule-set/${local.receipt_rule_set_name}:receipt-rule/${local.receipt_rule_name}"
}

# One key for the raw mail and the notifications. SES encrypts with it when it writes the
# object and publishes; the agent-worker's role decrypts through IAM (the root statement).
data "aws_iam_policy_document" "inbound_key" {
  statement {
    sid       = "Account"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
  statement {
    sid       = "SesWritesAndPublishes"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
  statement {
    sid       = "SnsDeliversToSqs"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "inbound" {
  description         = "${var.name} inbound email (FEAT-036)"
  enable_key_rotation = true
  policy              = data.aws_iam_policy_document.inbound_key.json
}

resource "aws_kms_alias" "inbound" {
  name          = "alias/${var.name}-inbound-mail"
  target_key_id = aws_kms_key.inbound.key_id
}

# Raw messages: written by SES only, deleted by the agent-worker once the message is
# stored, and expired after 7 days whatever happens (FEAT-036 §5.6). No versioning, so a
# delete is final.
resource "aws_s3_bucket" "inbound" {
  bucket        = var.inbound_bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "inbound" {
  bucket                  = aws_s3_bucket.inbound.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.inbound.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    id     = "expire-raw-mail"
    status = "Enabled"
    filter {}
    expiration {
      days = var.inbound_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "inbound_bucket" {
  statement {
    sid       = "SesPutsRawMail"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.inbound.arn}/${local.inbound_prefix}*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.receipt_rule_arn]
    }
  }
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.inbound.arn, "${aws_s3_bucket.inbound.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  policy = data.aws_iam_policy_document.inbound_bucket.json
}

# Received-mail notifications and the configuration set's bounces and complaints.
resource "aws_sns_topic" "inbound" {
  name              = "${var.name}-email-inbound"
  kms_master_key_id = aws_kms_key.inbound.arn
}

data "aws_iam_policy_document" "inbound_topic" {
  statement {
    sid       = "SesPublishes"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.inbound.arn]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "inbound" {
  arn    = aws_sns_topic.inbound.arn
  policy = data.aws_iam_policy_document.inbound_topic.json
}

# Standard queues, as SNS delivers to them; the consumer is idempotent on the SES message
# ID (inbound_events), so a duplicate delivery is harmless. Mirrors infra/local 01-queues.sh.
resource "aws_sqs_queue" "inbound_dlq" {
  name                      = "${var.name}-email-inbound-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "inbound" {
  name                       = "${var.name}-email-inbound"
  visibility_timeout_seconds = 120
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.inbound_dlq.arn
    maxReceiveCount     = 5
  })
}

data "aws_iam_policy_document" "inbound_queue" {
  statement {
    sid       = "TopicSends"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.inbound.arn]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.inbound.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "inbound" {
  queue_url = aws_sqs_queue.inbound.id
  policy    = data.aws_iam_policy_document.inbound_queue.json
}

# The consumer reads the SNS envelope (it checks TopicArn), so no raw delivery.
resource "aws_sns_topic_subscription" "inbound" {
  topic_arn            = aws_sns_topic.inbound.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.inbound.arn
  raw_message_delivery = false
}

# Receiving: one active rule set, one rule for the whole in. domain. Spam and virus
# scanning is on (the verdicts reach the consumer, which ignores spam and unsafe mail),
# and senders must use TLS.
resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = local.receipt_rule_set_name
}

resource "aws_ses_active_receipt_rule_set" "inbound" {
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
}

resource "aws_ses_receipt_rule" "forwarded" {
  name          = local.receipt_rule_name
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  recipients    = [local.inbound_domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.inbound.bucket
    object_key_prefix = local.inbound_prefix
    topic_arn         = aws_sns_topic.inbound.arn
  }

  # SES checks it can write and publish when the rule is created.
  depends_on = [aws_s3_bucket_policy.inbound, aws_sns_topic_policy.inbound, aws_kms_key.inbound]
}

# Bounces and complaints for every identity on the configuration set (the in. domain and
# each tenant's own domain, which the api creates with SES_CONFIGURATION_SET).
resource "aws_sesv2_configuration_set_event_destination" "feedback" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "bounces-and-complaints"
  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]
    sns_destination {
      topic_arn = aws_sns_topic.inbound.arn
    }
  }
}

# Replies go out from <tenant>@in.<mail_domain> until a tenant verifies its own domain.
resource "aws_sesv2_email_identity" "inbound" {
  email_identity         = local.inbound_domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "inbound" {
  email_identity         = aws_sesv2_email_identity.inbound.email_identity
  mail_from_domain       = local.inbound_mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}
