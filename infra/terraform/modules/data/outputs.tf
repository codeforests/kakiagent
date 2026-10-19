output "database_endpoint" {
  description = "Writer endpoint (host:port for RDS, host for Aurora)."
  value       = var.database_engine == "rds" ? aws_db_instance.this[0].address : aws_rds_cluster.this[0].endpoint
}

output "database_reader_endpoint" {
  description = "Reader endpoint; the writer when there is no reader (RDS)."
  value       = var.database_engine == "rds" ? aws_db_instance.this[0].address : aws_rds_cluster.this[0].reader_endpoint
}

output "database_master_secret_arn" {
  description = "Secrets Manager ARN of the owner credentials (used only by migrations)."
  value       = var.database_engine == "rds" ? aws_db_instance.this[0].master_user_secret[0].secret_arn : aws_rds_cluster.this[0].master_user_secret[0].secret_arn
}

output "valkey_endpoint" {
  description = "Valkey primary endpoint."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "kms_key_arn" {
  description = "KMS key for data at rest."
  value       = aws_kms_key.data.arn
}

output "database_summary" {
  description = "Engine, size and resilience settings of the system of record."
  value = {
    engine         = var.database_engine
    instances      = var.database_engine == "rds" ? length(aws_db_instance.this) : length(aws_rds_cluster_instance.this)
    instance_class = var.database_engine == "rds" ? aws_db_instance.this[0].instance_class : "db.serverless"
    multi_az       = var.database_engine == "rds" ? aws_db_instance.this[0].multi_az : length(aws_rds_cluster_instance.this) > 1
    backup_days    = var.database_engine == "rds" ? aws_db_instance.this[0].backup_retention_period : aws_rds_cluster.this[0].backup_retention_period
  }
}
