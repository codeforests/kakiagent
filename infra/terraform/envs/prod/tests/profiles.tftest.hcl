# Plans both profiles against mocked providers (no AWS account needed) and checks that
# each builds what ADR-023 / ADR-024 and ADR-003 / ADR-004 say. Run: terraform test

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-southeast-1a", "ap-southeast-1b", "ap-southeast-1c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-0123456789abcdef0" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "random" {}

variables {
  allowed_account_ids    = ["000000000000"]
  origin_domain_name     = "origin.example.sg"
  origin_certificate_arn = "arn:aws:acm:ap-southeast-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
}

run "launch_profile" {
  command = plan

  assert {
    condition     = contains(keys(module.queues.queue_urls), "ingest") && contains(keys(module.queues.queue_urls), "conversation-turns")
    error_message = "Each outbox topic has its queue: conversation-turns and ingest (FEAT-012)."
  }
  assert {
    condition     = length(module.network.app_subnet_ids) == 2
    error_message = "The launch profile uses 2 AZs (ADR-023)."
  }
  assert {
    condition     = module.data.database_summary.engine == "rds" && module.data.database_summary.instances == 1
    error_message = "The launch profile runs RDS PostgreSQL, not Aurora (ADR-024)."
  }
  assert {
    condition     = module.data.database_summary.multi_az == false && module.data.database_summary.instance_class == "db.t4g.small"
    error_message = "RDS is db.t4g.small, single AZ (ADR-024)."
  }
  assert {
    condition     = module.data.database_summary.backup_days == 35
    error_message = "Backups keep 35 days (NFR-08)."
  }
  assert {
    condition     = module.network.nat_gateway_count == 0 && module.network.nat_instance_count == 1
    error_message = "The launch profile uses one NAT instance (ADR-023 C1)."
  }
  assert {
    condition     = module.network.interface_endpoint_count == 0
    error_message = "The launch profile has no interface endpoints (ADR-023)."
  }
  assert {
    condition     = module.service["api"].task_count_range.min == 1 && module.service["ingest-worker"].task_count_range.min == 0
    error_message = "One task per role; ingest-worker scales to zero (ADR-023)."
  }
}

run "full_profile" {
  command = plan

  variables {
    profile = "full"
  }

  assert {
    condition     = length(module.network.app_subnet_ids) == 3
    error_message = "The full profile uses 3 AZs (ADR-003)."
  }
  assert {
    condition     = module.data.database_summary.engine == "aurora" && module.data.database_summary.instances == 2 && module.data.database_summary.multi_az
    error_message = "The full profile runs Aurora writer + reader (ADR-004)."
  }
  assert {
    condition     = module.network.nat_gateway_count == 3 && module.network.nat_instance_count == 0
    error_message = "The full profile uses a NAT gateway per AZ (ADR-003)."
  }
  assert {
    condition     = module.network.interface_endpoint_count == 8
    error_message = "The full profile has the interface endpoints (ADR-003)."
  }
  assert {
    condition     = module.service["api"].task_count_range.min == 2
    error_message = "The full profile keeps at least 2 api tasks (ADR-003)."
  }
}
