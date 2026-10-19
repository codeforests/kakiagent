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

output "nat_gateway_count" {
  description = "NAT gateways created (0 with a NAT instance)."
  value       = length(aws_nat_gateway.this)
}

output "nat_instance_count" {
  description = "NAT instances (Auto Scaling group size; 0 with NAT gateways)."
  value       = length(aws_autoscaling_group.nat)
}

output "interface_endpoint_count" {
  description = "Interface VPC endpoints created."
  value       = length(aws_vpc_endpoint.interface)
}
