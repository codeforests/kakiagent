variable "name" {
  description = "Name prefix for every resource."
  type        = string
}

variable "region" {
  description = "AWS region; must be ap-southeast-1 (ADR-003)."
  type        = string
}

variable "cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.20.0.0/16"
}

variable "nat_gateway_count" {
  description = "NAT gateways: 1 in dev to save cost, 3 (one per AZ) in staging and prod."
  type        = number
  default     = 3
  validation {
    condition     = var.nat_gateway_count >= 1 && var.nat_gateway_count <= 3
    error_message = "Use between 1 and 3 NAT gateways."
  }
}
