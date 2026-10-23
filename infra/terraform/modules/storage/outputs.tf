output "bucket_names" {
  description = "Bucket name per purpose."
  value       = { for k, b in aws_s3_bucket.this : k => b.bucket }
}

output "bucket_arns" {
  description = "Bucket ARN per purpose."
  value       = { for k, b in aws_s3_bucket.this : k => b.arn }
}

output "static_bucket_regional_domain_name" {
  description = "Origin domain for CloudFront."
  value       = aws_s3_bucket.this["static"].bucket_regional_domain_name
}

output "upload_scanning" {
  description = "How quarantine uploads are scanned and who may PUT them (FEAT-015)."
  value = {
    malware_protection = var.malware_protection
    object_prefixes    = var.malware_protection ? one(one(aws_guardduty_malware_protection_plan.quarantine[0].protected_resource).s3_bucket).object_prefixes : []
    tagging            = var.malware_protection ? one(one(aws_guardduty_malware_protection_plan.quarantine[0].actions).tagging).status : null
    upload_origins     = var.upload_origins
  }
}
