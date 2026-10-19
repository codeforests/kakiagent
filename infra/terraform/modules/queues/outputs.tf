output "queue_urls" {
  description = "Queue URL per topic."
  value       = { for k, q in aws_sqs_queue.this : k => q.url }
}

output "queue_arns" {
  description = "Queue ARN per topic."
  value       = { for k, q in aws_sqs_queue.this : k => q.arn }
}
