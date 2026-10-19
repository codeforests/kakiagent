output "target_group_arns" {
  description = "Target group ARN per HTTP role."
  value       = { for k, t in aws_lb_target_group.role : k => t.arn }
}

output "distribution_domain_name" {
  description = "CloudFront domain."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation on deploy)."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN."
  value       = aws_cloudfront_distribution.this.arn
}
