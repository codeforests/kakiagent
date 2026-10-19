variable "allowed_account_ids" {
  description = "The dev AWS account ID, so a plan can never run against another account."
  type        = list(string)
}

variable "name" {
  description = "Name prefix for dev resources."
  type        = string
  default     = "kaki-dev"
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
