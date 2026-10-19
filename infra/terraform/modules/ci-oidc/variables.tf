variable "name" {
  description = "Name prefix."
  type        = string
}

variable "github_repository" {
  description = "owner/repo allowed to deploy."
  type        = string
}

variable "github_environment" {
  description = "GitHub environment whose jobs may assume the role."
  type        = string
}

variable "ecr_repository_arns" {
  description = "Repositories CI may push to."
  type        = list(string)
}

variable "static_bucket_arn" {
  description = "Static-assets bucket."
  type        = string
}

variable "cloudfront_distribution_arn" {
  description = "Distribution CI may invalidate."
  type        = string
}
