# Email authentication for outgoing mail (NFR-18; FEAT-052 §5.6, D14): an SES domain
# identity signed with Easy DKIM (RSA 2048), a custom MAIL FROM domain for SPF alignment,
# a DMARC record, and a bounce-rate alarm. DNS lives outside AWS, so the records are an
# output to add by hand. Written now; applied at milestone MD.

locals {
  mail_from_domain = "mail.${var.mail_domain}"
  spf_value        = "v=spf1 include:amazonses.com -all"
  dmarc_record = {
    name  = "_dmarc.${var.mail_domain}"
    type  = "TXT"
    value = "v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:${var.dmarc_report_address}"
  }
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = "${var.name}-mail"

  reputation_options {
    reputation_metrics_enabled = true
  }
  sending_options {
    sending_enabled = true
  }
}

resource "aws_sesv2_email_identity" "this" {
  email_identity         = var.mail_domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "this" {
  email_identity         = aws_sesv2_email_identity.this.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_cloudwatch_metric_alarm" "bounce_rate" {
  alarm_name          = "${var.name}-ses-bounce-rate"
  alarm_description   = "SES bounce rate above ${var.bounce_rate_threshold * 100}% (NFR-18)."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.BounceRate"
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = var.bounce_rate_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arns
  ok_actions          = var.alarm_topic_arns
}
