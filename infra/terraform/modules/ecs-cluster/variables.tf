variable "name" {
  description = "Name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "roles" {
  description = "Runtime roles that get an image repository (ADR-001)."
  type        = list(string)
  default     = ["api", "realtime", "agent-worker", "ingest-worker", "scheduler-worker"]
}
