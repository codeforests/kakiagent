output "public_url" {
  description = "CloudFront URL for the dashboard, widget and API."
  value       = local.public_url
}

output "ecr_repositories" {
  description = "Image repository per role."
  value       = module.cluster.repository_urls
}

output "deploy_role_arn" {
  description = "Role GitHub Actions assumes to deploy."
  value       = module.ci.deploy_role_arn
}

output "database_endpoint" {
  description = "PostgreSQL writer endpoint (RDS in the launch profile, Aurora in full)."
  value       = module.data.database_endpoint
}
