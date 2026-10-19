output "aurora_endpoint" {
  description = "Writer endpoint."
  value       = aws_rds_cluster.this.endpoint
}

output "aurora_reader_endpoint" {
  description = "Reader endpoint."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "aurora_master_secret_arn" {
  description = "Secrets Manager ARN of the owner credentials (used only by migrations)."
  value       = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

output "valkey_endpoint" {
  description = "Valkey primary endpoint."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "kms_key_arn" {
  description = "KMS key for data at rest."
  value       = aws_kms_key.data.arn
}
