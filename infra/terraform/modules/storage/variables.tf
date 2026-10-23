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

variable "upload_origins" {
  description = "Origins whose browsers PUT uploads into quarantine (the dashboard; FEAT-015)."
  type        = list(string)
  default     = []
}

variable "malware_protection" {
  description = "Scan quarantine uploads with GuardDuty Malware Protection for S3 (FEAT-015, ADR-019)."
  type        = bool
  default     = true
}
