variable "allowed_account_ids" {
  description = "The prod workload account ID, so a plan can never run against another account."
  type        = list(string)
}

variable "profile" {
  description = "\"launch\": the lean profile until the prod trigger (ADR-023, ADR-024). \"full\": the ADR-003/ADR-004 design restored at the trigger."
  type        = string
  default     = "launch"
  validation {
    condition     = contains(["launch", "full"], var.profile)
    error_message = "profile is \"launch\" or \"full\"."
  }
}

variable "name" {
  description = "Name prefix for resources in this account."
  type        = string
  default     = "kaki-prod"
}

variable "image_tag" {
  description = "Image tag or digest to run (CI passes the commit's digest)."
  type        = string
  default     = "latest"
}

variable "github_repository" {
  description = "Repository allowed to deploy through OIDC."
  type        = string
  default     = "codeforests/kakiagent"
}

variable "origin_domain_name" {
  description = "DNS name of the ALB origin, for example origin.<domain>. Point it at the alb_dns_name output."
  type        = string
}

variable "origin_certificate_arn" {
  description = "ACM certificate in ap-southeast-1 covering origin_domain_name."
  type        = string
}
