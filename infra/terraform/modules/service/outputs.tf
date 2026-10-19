output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.this.name
}

output "task_role_arn" {
  description = "Task role ARN."
  value       = aws_iam_role.task.arn
}

output "log_group_name" {
  description = "CloudWatch log group."
  value       = aws_cloudwatch_log_group.this.name
}

output "task_count_range" {
  description = "Auto-scaling minimum and maximum tasks."
  value       = { min = aws_appautoscaling_target.this.min_capacity, max = aws_appautoscaling_target.this.max_capacity }
}
