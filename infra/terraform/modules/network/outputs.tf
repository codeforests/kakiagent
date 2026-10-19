output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Public subnets (ALB, NAT)."
  value       = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  description = "Private app subnets (ECS tasks)."
  value       = aws_subnet.app[*].id
}

output "data_subnet_ids" {
  description = "Isolated data subnets (Aurora, Valkey)."
  value       = aws_subnet.data[*].id
}

output "app_subnet_cidrs" {
  description = "CIDRs of the app subnets."
  value       = aws_subnet.app[*].cidr_block
}
