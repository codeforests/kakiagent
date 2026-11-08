variable "name" {
  description = "Name prefix."
  type        = string
}

variable "mail_domain" {
  description = "Domain the alert and account emails are sent from (no-reply@<mail_domain>)."
  type        = string
}

variable "dmarc_report_address" {
  description = "Mailbox that receives DMARC aggregate reports (rua)."
  type        = string
}

variable "region" {
  description = "SES region; the MAIL FROM MX points at its feedback endpoint."
  type        = string
  default     = "ap-southeast-1"
}

variable "bounce_rate_threshold" {
  description = "Alarm when the SES reputation bounce rate is above this fraction (NFR-18: 5%)."
  type        = number
  default     = 0.05
}

variable "alarm_topic_arns" {
  description = "SNS topics notified when the bounce-rate alarm changes state; none until MD's alerting."
  type        = list(string)
  default     = []
}

variable "inbound_bucket_name" {
  description = "Bucket SES writes received mail to (FEAT-036); bucket names are global, so include the account."
  type        = string
}

variable "inbound_retention_days" {
  description = "Raw received mail expires after this many days, even if the agent-worker never deleted it (FEAT-036 §5.6)."
  type        = number
  default     = 7
}
