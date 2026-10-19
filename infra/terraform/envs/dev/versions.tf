terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
  # Remote state in ap-southeast-1 (ADR-003). The bucket and lock table are created by
  # the account bootstrap at MD; pass them with `terraform init -backend-config=dev.s3.tfbackend`.
  backend "s3" {}
}

provider "aws" {
  region              = "ap-southeast-1"
  allowed_account_ids = var.allowed_account_ids
  default_tags {
    tags = { Project = "kakiagent", Environment = "dev", ManagedBy = "terraform" }
  }
}

# Only for the CloudFront-scoped WAF ACL (see modules/edge).
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = var.allowed_account_ids
  default_tags {
    tags = { Project = "kakiagent", Environment = "dev", ManagedBy = "terraform" }
  }
}
