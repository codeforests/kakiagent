variable "name" {
  description = "Name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB."
  type        = list(string)
}

variable "app_subnet_cidrs" {
  description = "App subnet CIDRs (ALB egress)."
  type        = list(string)
}

variable "tasks_security_group_id" {
  description = "Task security group, opened to the ALB on the HTTP ports."
  type        = string
}

variable "http_ports" {
  description = "Container port per HTTP role."
  type        = map(number)
  default     = { api = 3000, realtime = 3001 }
}

variable "static_bucket_name" {
  description = "The static-assets bucket."
  type        = string
}

variable "static_bucket_arn" {
  description = "ARN of the static-assets bucket."
  type        = string
}

variable "static_bucket_regional_domain_name" {
  description = "Regional domain of the static-assets bucket."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate (ap-southeast-1) for the ALB listener, covering origin_domain_name. CloudFront reaches the origin over HTTPS only."
  type        = string
}

variable "origin_domain_name" {
  description = "DNS name CloudFront uses for the ALB origin (for example origin.<domain>), on the certificate and pointing at the ALB."
  type        = string
}

variable "cloudfront_certificate_arn" {
  description = "ACM certificate (us-east-1) for custom domains; null uses the CloudFront default domain."
  type        = string
  default     = null
}

variable "domain_names" {
  description = "Custom domain names for the distribution."
  type        = list(string)
  default     = []
}

variable "rate_limit_per_5_min" {
  description = "Requests per IP per 5 minutes before WAF blocks (GOV-13 baseline)."
  type        = number
  default     = 2000
}

variable "deletion_protection" {
  description = "Protect the ALB from deletion."
  type        = bool
  default     = true
}
