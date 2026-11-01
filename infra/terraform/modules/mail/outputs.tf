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
  )
}
