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

output "alb_dns_name" {
  description = "Point origin_domain_name at this (a CNAME or alias record)."
  value       = aws_lb.this.dns_name
}

output "routes" {
  description = "What reaches the origin: ALB api paths, CloudFront's uncached paths, the WAF rules."
  value = {
    api_paths = local.api_paths
    alb_paths = local.alb_paths
    waf_rules = [for r in aws_wafv2_web_acl.this.rule : r.name]
  }
}
