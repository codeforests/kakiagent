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
