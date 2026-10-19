variable "name" {
  description = "Name prefix (bucket names are global, so include the account or environment)."
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for the data buckets."
  type        = string
}

variable "audit_anchor_retention_days" {
  description = "Object Lock retention for audit-chain anchors (ADR-014)."
  type        = number
  default     = 2555
}

variable "force_destroy" {
  description = "Allow destroying non-empty buckets (dev only). Never applies to audit-anchors."
  type        = bool
  default     = false
}
