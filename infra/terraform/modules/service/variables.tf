variable "role" {
  description = "Runtime role name (api, realtime, agent-worker, ingest-worker, scheduler-worker)."
  type        = string
}

variable "cluster_arn" {
  description = "ECS cluster ARN."
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster name."
  type        = string
}

variable "image" {
  description = "Image reference, pinned by digest when promoting (architecture §7)."
  type        = string
}

variable "port" {
  description = "Container port: the HTTP port, or the health port for workers."
  type        = number
}

variable "cpu" {
  description = "Task CPU units."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Task memory (MiB)."
  type        = number
  default     = 1024
}

variable "environment" {
  description = "Plain environment variables."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Environment variables read from Secrets Manager (name => secret ARN, optionally with :key::)."
  type        = map(string)
  default     = {}
}

variable "task_policy_json" {
  description = "IAM policy for the task role, or null."
  type        = string
  default     = null
}

variable "subnet_ids" {
  description = "Private app subnets."
  type        = list(string)
}

variable "security_group_id" {
  description = "Task security group."
  type        = string
}

variable "target_group_arn" {
  description = "ALB target group, for HTTP roles."
  type        = string
  default     = null
}

variable "min_count" {
  description = "Minimum tasks (2 for latency-critical roles, architecture §7)."
  type        = number
  default     = 2
}

variable "max_count" {
  description = "Maximum tasks."
  type        = number
  default     = 6
}

variable "scale_on_queue_name" {
  description = "Scale on this SQS queue's oldest-message age instead of CPU."
  type        = string
  default     = null
}

variable "queue_age_target_seconds" {
  description = "Target age of the oldest message (agent-worker: under 1 s)."
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention."
  type        = number
  default     = 30
}
