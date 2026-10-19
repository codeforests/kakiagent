# The dev environment (ADR-003, architecture §7), written and validated in FEAT-001 and
# applied at milestone MD. Dev trims cost: one NAT gateway, one Aurora instance, no
# Valkey replica, one task per role. Staging and prod reuse these modules with the
# architecture's minimums.

data "aws_caller_identity" "current" {}

locals {
  region     = "ap-southeast-1"
  bucket_pfx = "${var.name}-${data.aws_caller_identity.current.account_id}"
  roles = {
    api              = { port = 3000, http = true }
    realtime         = { port = 3001, http = true }
    agent-worker     = { port = 3002, http = false }
    ingest-worker    = { port = 3003, http = false }
    scheduler-worker = { port = 3004, http = false }
  }
  common_env = {
    NODE_ENV  = "production"
    LOG_LEVEL = "info"
    HOST      = "0.0.0.0"
  }
  public_url = "https://${module.edge.distribution_domain_name}"
}

module "network" {
  source            = "../../modules/network"
  name              = var.name
  region            = local.region
  nat_gateway_count = 1
}

module "cluster" {
  source = "../../modules/ecs-cluster"
  name   = var.name
  vpc_id = module.network.vpc_id
}

module "data" {
  source                = "../../modules/data"
  name                  = var.name
  vpc_id                = module.network.vpc_id
  data_subnet_ids       = module.network.data_subnet_ids
  app_security_group_id = module.cluster.tasks_security_group_id
  aurora_instance_count = 1
  aurora_max_acu        = 4
  valkey_replicas       = 0
  deletion_protection   = false
}

module "queues" {
  source = "../../modules/queues"
  name   = var.name
}

module "storage" {
  source        = "../../modules/storage"
  name          = local.bucket_pfx
  kms_key_arn   = module.data.kms_key_arn
  force_destroy = true
}

module "edge" {
  source                             = "../../modules/edge"
  providers                          = { aws = aws, aws.us_east_1 = aws.us_east_1 }
  name                               = var.name
  vpc_id                             = module.network.vpc_id
  public_subnet_ids                  = module.network.public_subnet_ids
  app_subnet_cidrs                   = module.network.app_subnet_cidrs
  tasks_security_group_id            = module.cluster.tasks_security_group_id
  static_bucket_name                 = module.storage.bucket_names["static"]
  static_bucket_arn                  = module.storage.bucket_arns["static"]
  static_bucket_regional_domain_name = module.storage.static_bucket_regional_domain_name
  deletion_protection                = false
}

# Application secrets: the per-trust-zone database URLs (ADR-005) and token keys. Values
# are set out of band at MD (`pnpm db:setup` creates the roles), never in Terraform state.
resource "aws_secretsmanager_secret" "app" {
  for_each   = toset(["dashboard-database-url", "visitor-database-url", "outbox-database-url", "visitor-token-secret", "session-secret"])
  name       = "${var.name}/${each.key}"
  kms_key_id = module.data.kms_key_arn
}

locals {
  secret = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
  valkey = "rediss://${module.data.valkey_endpoint}:6379"
}

data "aws_iam_policy_document" "turns_consumer" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
    resources = [module.queues.queue_arns["conversation-turns"]]
  }
}

data "aws_iam_policy_document" "turns_producer" {
  statement {
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
    resources = values(module.queues.queue_arns)
  }
}

module "service" {
  source   = "../../modules/service"
  for_each = local.roles

  role              = each.key
  cluster_arn       = module.cluster.cluster_arn
  cluster_name      = module.cluster.cluster_name
  image             = "${module.cluster.repository_urls[each.key]}:${var.image_tag}"
  port              = each.value.port
  subnet_ids        = module.network.app_subnet_ids
  security_group_id = module.cluster.tasks_security_group_id
  target_group_arn  = each.value.http ? module.edge.target_group_arns[each.key] : null
  min_count         = 1
  max_count         = 2

  scale_on_queue_name = each.key == "agent-worker" ? "${var.name}-conversation-turns.fifo" : null
  task_policy_json = (
    each.key == "agent-worker" ? data.aws_iam_policy_document.turns_consumer.json :
    each.key == "scheduler-worker" ? data.aws_iam_policy_document.turns_producer.json : null
  )

  environment = merge(
    local.common_env,
    { for k, v in {
      api = {
        PORT                    = "3000"
        VALKEY_URL              = local.valkey
        PUBLIC_REALTIME_URL     = local.public_url
        PUBLIC_WIDGET_PANEL_URL = "${local.public_url}/w/v1/panel.js"
        KAKI_DEV_AUTH           = "false"
      }
      realtime = { PORT = "3001", VALKEY_URL = local.valkey }
      agent-worker = {
        HEALTH_PORT         = "3002"
        AWS_REGION          = local.region
        SQS_TURNS_QUEUE_URL = module.queues.queue_urls["conversation-turns"]
        VALKEY_URL          = local.valkey
        LLM_PROVIDER        = "fake" # the Bedrock au. provider arrives at MD (ADR-006)
      }
      ingest-worker = { HEALTH_PORT = "3003" }
      scheduler-worker = {
        HEALTH_PORT         = "3004"
        AWS_REGION          = local.region
        SQS_TURNS_QUEUE_URL = module.queues.queue_urls["conversation-turns"]
      }
    }[each.key] : k => v },
  )

  secrets = {
    api = {
      DASHBOARD_DATABASE_URL = local.secret["dashboard-database-url"]
      VISITOR_DATABASE_URL   = local.secret["visitor-database-url"]
      VISITOR_TOKEN_SECRET   = local.secret["visitor-token-secret"]
      SESSION_SECRET         = local.secret["session-secret"]
    }
    realtime = {
      DASHBOARD_DATABASE_URL = local.secret["dashboard-database-url"]
      VISITOR_DATABASE_URL   = local.secret["visitor-database-url"]
      VISITOR_TOKEN_SECRET   = local.secret["visitor-token-secret"]
      SESSION_SECRET         = local.secret["session-secret"]
    }
    agent-worker     = { VISITOR_DATABASE_URL = local.secret["visitor-database-url"] }
    ingest-worker    = {}
    scheduler-worker = { OUTBOX_DATABASE_URL = local.secret["outbox-database-url"] }
  }[each.key]
}

module "ci" {
  source                      = "../../modules/ci-oidc"
  name                        = var.name
  github_repository           = var.github_repository
  github_environment          = "dev"
  ecr_repository_arns         = module.cluster.repository_arns
  static_bucket_arn           = module.storage.bucket_arns["static"]
  cloudfront_distribution_arn = module.edge.distribution_arn
}
