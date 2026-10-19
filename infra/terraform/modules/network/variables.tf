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

variable "az_count" {
  description = "Availability Zones: 2 for the launch profile (ADR-023), 3 for ADR-003."
  type        = number
  default     = 3
  validation {
    condition     = var.az_count == 2 || var.az_count == 3
    error_message = "Use 2 (launch) or 3 (ADR-003) AZs."
  }
}

variable "nat_mode" {
  description = "\"instance\": one fck-nat instance (launch, ADR-023 C1). \"gateway\": a NAT gateway per AZ (ADR-003)."
  type        = string
  default     = "gateway"
  validation {
    condition     = contains(["instance", "gateway"], var.nat_mode)
    error_message = "nat_mode is \"instance\" or \"gateway\"."
  }
}

variable "nat_instance_type" {
  description = "Instance type of the NAT instance."
  type        = string
  default     = "t4g.nano"
}

variable "interface_endpoints" {
  description = "Create interface endpoints for SQS, KMS, Secrets Manager, CloudWatch, ECR and Bedrock (ADR-003). Off in the launch profile."
  type        = bool
  default     = true
}
