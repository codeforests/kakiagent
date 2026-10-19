variable "name" {
  description = "Name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "data_subnet_ids" {
  description = "Isolated data subnets."
  type        = list(string)
}

variable "app_security_group_id" {
  description = "Security group of the ECS tasks allowed to connect."
  type        = string
}

variable "database_engine" {
  description = "\"rds\": RDS PostgreSQL single AZ (launch, ADR-024). \"aurora\": Aurora PostgreSQL (ADR-004)."
  type        = string
  default     = "aurora"
  validation {
    condition     = contains(["rds", "aurora"], var.database_engine)
    error_message = "database_engine is \"rds\" or \"aurora\"."
  }
}

variable "rds_engine_version" {
  description = "RDS PostgreSQL version (16, as ADR-004)."
  type        = string
  default     = "16.6"
}

variable "rds_instance_class" {
  description = "RDS instance class (ADR-024: db.t4g.small, upsize to db.t4g.medium on the stated signals)."
  type        = string
  default     = "db.t4g.small"
}

variable "rds_allocated_storage_gb" {
  description = "Initial gp3 storage (ADR-024: 20 GB)."
  type        = number
  default     = 20
}

variable "rds_max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 200
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL version (pgvector is available from 15.4 / 16.1)."
  type        = string
  default     = "16.6"
}

variable "aurora_min_acu" {
  description = "Serverless v2 minimum ACUs per instance (architecture §7: 0.5)."
  type        = number
  default     = 0.5
}

variable "aurora_max_acu" {
  description = "Serverless v2 maximum ACUs per instance (architecture §7: 16)."
  type        = number
  default     = 16
}

variable "aurora_instance_count" {
  description = "Writer plus readers: 1 in dev, 2 (Multi-AZ) in staging and prod."
  type        = number
  default     = 2
}

variable "valkey_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "valkey_replicas" {
  description = "Read replicas: 0 in dev, 1 in staging and prod."
  type        = number
  default     = 1
}

variable "deletion_protection" {
  description = "Protect the database from deletion (true outside dev)."
  type        = bool
  default     = true
}
