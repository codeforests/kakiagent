output "from_address" {
  description = "The sender address for EMAIL_FROM."
  value       = "no-reply@${var.mail_domain}"
}

output "dkim_signing_key_length" {
  description = "Easy DKIM key length."
  value       = aws_sesv2_email_identity.this.dkim_signing_attributes[0].next_signing_key_length
}

output "mail_from_domain" {
  description = "Custom MAIL FROM domain (SPF alignment)."
  value       = aws_sesv2_email_identity_mail_from_attributes.this.mail_from_domain
}

output "dmarc_record" {
  description = "The DMARC TXT record."
  value       = local.dmarc_record
}

output "bounce_alarm" {
  description = "The bounce-rate alarm's metric and threshold."
  value = {
    metric    = aws_cloudwatch_metric_alarm.bounce_rate.metric_name
    threshold = aws_cloudwatch_metric_alarm.bounce_rate.threshold
    operator  = aws_cloudwatch_metric_alarm.bounce_rate.comparison_operator
  }
}

output "dns_records" {
  description = "Records to add at the DNS host: three DKIM CNAMEs, the MAIL FROM MX and SPF TXT, and DMARC."
  value = concat(
    [for t in aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens : {
      name  = "${t}._domainkey.${var.mail_domain}"
      type  = "CNAME"
      value = "${t}.dkim.amazonses.com"
    }],
    [
      { name = local.mail_from_domain, type = "MX", value = "10 feedback-smtp.${var.region}.amazonses.com" },
      { name = local.mail_from_domain, type = "TXT", value = local.spf_value },
      local.dmarc_record,
    ],
    # The email channel's forwarding domain (FEAT-036): receiving MX, its own DKIM and MAIL FROM.
    [local.inbound_mx_record],
    [for t in aws_sesv2_email_identity.inbound.dkim_signing_attributes[0].tokens : {
      name  = "${t}._domainkey.${local.inbound_domain}"
      type  = "CNAME"
      value = "${t}.dkim.amazonses.com"
    }],
    [
      { name = local.inbound_mail_from_domain, type = "MX", value = "10 feedback-smtp.${var.region}.amazonses.com" },
      { name = local.inbound_mail_from_domain, type = "TXT", value = local.spf_value },
    ],
  )
}

output "configuration_set_name" {
  description = "SES configuration set for SES_CONFIGURATION_SET: identities on it report bounces and complaints to the inbound topic."
  value       = aws_sesv2_configuration_set.this.configuration_set_name
}

output "configuration_set_arn" {
  description = "ARN of the configuration set (CreateEmailIdentity names it)."
  value       = aws_sesv2_configuration_set.this.arn
}

output "message_id_domain" {
  description = "SES rewrites outgoing Message-IDs to <id>@<this> (SES_MESSAGE_ID_DOMAIN)."
  value       = "${var.region}.amazonses.com"
}

output "inbound" {
  description = "The email channel's receiving side (FEAT-036 §5.6)."
  value = {
    domain             = local.inbound_domain
    bucket_name        = aws_s3_bucket.inbound.bucket
    bucket_arn         = aws_s3_bucket.inbound.arn
    object_prefix      = local.inbound_prefix
    kms_key_arn        = aws_kms_key.inbound.arn
    topic_arn          = aws_sns_topic.inbound.arn
    queue_url          = aws_sqs_queue.inbound.url
    queue_arn          = aws_sqs_queue.inbound.arn
    dlq_arn            = aws_sqs_queue.inbound_dlq.arn
    mx_record          = local.inbound_mx_record
    dead_letter_target = jsondecode(aws_sqs_queue.inbound.redrive_policy).deadLetterTargetArn
    max_receive_count  = jsondecode(aws_sqs_queue.inbound.redrive_policy).maxReceiveCount
    retention_days     = one(aws_s3_bucket_lifecycle_configuration.inbound.rule).expiration[0].days
    rule_set_active    = aws_ses_active_receipt_rule_set.inbound.rule_set_name == aws_ses_receipt_rule_set.inbound.rule_set_name
    rule_recipients    = aws_ses_receipt_rule.forwarded.recipients
    rule_scan_enabled  = aws_ses_receipt_rule.forwarded.scan_enabled
    rule_tls_policy    = aws_ses_receipt_rule.forwarded.tls_policy
    rule_bucket        = one(aws_ses_receipt_rule.forwarded.s3_action).bucket_name
    rule_topic_arn     = one(aws_ses_receipt_rule.forwarded.s3_action).topic_arn
    raw_delivery       = aws_sns_topic_subscription.inbound.raw_message_delivery
    feedback_events    = toset(aws_sesv2_configuration_set_event_destination.feedback.event_destination[0].matching_event_types)
    feedback_topic_arn = aws_sesv2_configuration_set_event_destination.feedback.event_destination[0].sns_destination[0].topic_arn
    identity           = aws_sesv2_email_identity.inbound.email_identity
    identity_dkim      = aws_sesv2_email_identity.inbound.dkim_signing_attributes[0].next_signing_key_length
    identity_mail_from = aws_sesv2_email_identity_mail_from_attributes.inbound.mail_from_domain
  }
}
