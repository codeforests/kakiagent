output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "repository_urls" {
  description = "ECR repository URL per role."
  value       = { for k, r in aws_ecr_repository.role : k => r.repository_url }
}

output "tasks_security_group_id" {
  description = "Security group shared by all tasks."
  value       = aws_security_group.tasks.id
}

output "repository_arns" {
  description = "ECR repository ARNs."
  value       = [for r in aws_ecr_repository.role : r.arn]
}
