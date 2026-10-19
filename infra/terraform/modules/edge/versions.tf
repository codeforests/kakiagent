terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
      # CloudFront-scoped WAF ACLs can only be created in us-east-1. They hold rules,
      # not tenant data, so residency (NFR-07) is unaffected.
      configuration_aliases = [aws.us_east_1]
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}
