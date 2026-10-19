output "public_url" {
  description = "CloudFront URL for the dashboard, widget and API."
  value       = local.public_url
}

output "ecr_repositories" {
  description = "Image repository per role."
  value       = module.cluster.repository_urls
}

output "deploy_role_arn" {
  description = "Role GitHub Actions assumes to deploy to dev."
  value       = module.ci.deploy_role_arn
}

output "aurora_endpoint" {
  description = "Aurora writer endpoint."
  value       = module.data.aurora_endpoint
}
