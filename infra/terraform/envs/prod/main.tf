# The prod account (ADR-023): until the prod trigger (10 paying tenants) it runs the
# lean launch profile; at the trigger, `profile = "full"` restores the ADR-003/ADR-004
# design and the database moves to Aurora (ADR-024's read-replica cut-over). Written
# and validated in FEAT-001, applied at milestone MD. Staging returns at the trigger
# as another root built from the same modules.

data "aws_caller_identity" "current" {}

locals {
  profiles = {
    launch = {
      az_count            = 2
      nat_mode            = "instance"
      interface_endpoints = false
      database_engine     = "rds"
      valkey_node_type    = "cache.t4g.micro"
      valkey_replicas     = 0
      min_tasks           = { api = 1, realtime = 1, agent-worker = 1, ingest-worker = 0, scheduler-worker = 1 }
    }
    full = {
      az_count            = 3
      nat_mode            = "gateway"
      interface_endpoints = true
      database_engine     = "aurora"
      valkey_node_type    = "cache.t4g.small"
      valkey_replicas     = 1
      min_tasks           = { api = 2, realtime = 2, agent-worker = 2, ingest-worker = 1, scheduler-worker = 2 }
    }
  }
  p = local.profiles[var.profile]

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
  source              = "../../modules/network"
  name                = var.name
  region              = local.region
  az_count            = local.p.az_count
  nat_mode            = local.p.nat_mode
  interface_endpoints = local.p.interface_endpoints
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
  database_engine       = local.p.database_engine
  valkey_node_type      = local.p.valkey_node_type
  valkey_replicas       = local.p.valkey_replicas
  deletion_protection   = true
}

module "queues" {
  source = "../../modules/queues"
  name   = var.name
}

module "storage" {
  source      = "../../modules/storage"
  name        = local.bucket_pfx
  kms_key_arn = module.data.kms_key_arn
  # The dashboard PUTs uploads to presigned quarantine URLs (FEAT-015 §3.2).
  upload_origins = [local.public_url]
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
  certificate_arn                    = var.origin_certificate_arn
  origin_domain_name                 = var.origin_domain_name
}

# Application secrets: the per-trust-zone database URLs (ADR-005), token keys, the MFA sealing
# key (FEAT-006, until the KMS sealer at MD) and the SMTP
# URL (it carries the SES SMTP credentials). Values
# are set out of band at MD (`pnpm db:setup` creates the roles), never in Terraform state.
# Each role's URL points at the database endpoint output.
resource "aws_secretsmanager_secret" "app" {
  for_each = toset([
    "dashboard-database-url", "visitor-database-url", "outbox-database-url", "identity-database-url",
    "ingest-database-url",
    "visitor-token-secret", "session-secret", "magic-link-secret", "smtp-url",
    "mfa-secret-key",
  ])
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

data "aws_iam_policy_document" "ingest_consumer" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
    resources = [module.queues.queue_arns["ingest"]]
  }
}

data "aws_iam_policy_document" "turns_producer" {
  statement {
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
    resources = values(module.queues.queue_arns)
  }
}

# Audit anchoring (ADR-014 decision 5): the scheduler writes chain heads to the Object
# Lock bucket. Put only; the bucket's compliance retention does the locking.
data "aws_iam_policy_document" "audit_anchor_writer" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${module.storage.bucket_arns["audit-anchors"]}/audit/*"]
  }
  statement {
    actions   = ["kms:GenerateDataKey"]
    resources = [module.data.kms_key_arn]
  }
}

# File uploads (FEAT-015 §5.8). The api only signs PUTs under quarantine/uploads/ (the
# browser does the PUT with the api's signature). The ingest worker reads, tags-checks
# and deletes quarantine objects and keeps clean copies in sources. ListBucket lets a
# missing key answer 404 (`upload_missing`) instead of 403.
data "aws_iam_policy_document" "upload_signer" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${module.storage.bucket_arns["quarantine"]}/uploads/*"]
  }
  statement {
    actions   = ["kms:GenerateDataKey"]
    resources = [module.data.kms_key_arn]
  }
}

data "aws_iam_policy_document" "file_store" {
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectTagging", "s3:DeleteObject"]
    resources = ["${module.storage.bucket_arns["quarantine"]}/uploads/*"]
  }
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${module.storage.bucket_arns["sources"]}/files/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [module.storage.bucket_arns["quarantine"], module.storage.bucket_arns["sources"]]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [module.data.kms_key_arn]
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
  # Minimums follow the profile; the maximums stay as ADR-003 (ADR-023).
  min_count = local.p.min_tasks[each.key]
  max_count = 6

  scale_on_queue_name = lookup({
    agent-worker  = "${var.name}-conversation-turns.fifo"
    ingest-worker = "${var.name}-ingest.fifo"
  }, each.key, null)
  # Extraction jobs run for minutes; a minute's wait before scaling out is fine (NFR-16).
  queue_age_target_seconds = each.key == "ingest-worker" ? 60 : 1
  task_policies = lookup({
    api          = { uploads = data.aws_iam_policy_document.upload_signer.json }
    agent-worker = { sqs = data.aws_iam_policy_document.turns_consumer.json }
    ingest-worker = {
      sqs   = data.aws_iam_policy_document.ingest_consumer.json
      files = data.aws_iam_policy_document.file_store.json
    }
    scheduler-worker = {
      sqs   = data.aws_iam_policy_document.turns_producer.json
      audit = data.aws_iam_policy_document.audit_anchor_writer.json
    }
  }, each.key, {})

  environment = merge(
    local.common_env,
    { for k, v in {
      api = {
        PORT                      = "3000"
        VALKEY_URL                = local.valkey
        PUBLIC_REALTIME_URL       = local.public_url
        PUBLIC_WIDGET_PANEL_URL   = "${local.public_url}/w/v1/panel.js"
        PUBLIC_WIDGET_LOADER_URL  = "${local.public_url}/w/v1/loader.js"
        PUBLIC_WIDGET_PREVIEW_URL = "${local.public_url}/w/v1/preview.html"
        PUBLIC_API_URL            = local.public_url
        PUBLIC_APP_URL            = local.public_url
        AWS_REGION                = local.region
        QUARANTINE_BUCKET         = module.storage.bucket_names["quarantine"]
      }
      realtime = { PORT = "3001", VALKEY_URL = local.valkey }
      agent-worker = {
        HEALTH_PORT         = "3002"
        AWS_REGION          = local.region
        SQS_TURNS_QUEUE_URL = module.queues.queue_urls["conversation-turns"]
        VALKEY_URL          = local.valkey
        LLM_PROVIDER        = "fake" # the Bedrock au. provider arrives at MD (ADR-006)
      }
      ingest-worker = {
        HEALTH_PORT          = "3003"
        AWS_REGION           = local.region
        SQS_INGEST_QUEUE_URL = module.queues.queue_urls["ingest"]
        WIDGET_ASSET_URL     = "${local.public_url}/w/v1/" # detect.js (FEAT-032 D4)
        LLM_PROVIDER         = "fake"                      # the Bedrock au. provider arrives at MD (ADR-006)
        QUARANTINE_BUCKET    = module.storage.bucket_names["quarantine"]
        SOURCES_BUCKET       = module.storage.bucket_names["sources"]
        MALWARE_SCANNER      = "guardduty" # FEAT-015 §5.3; ClamAV is the local stand-in
      }
      scheduler-worker = {
        HEALTH_PORT          = "3004"
        AWS_REGION           = local.region
        SQS_TURNS_QUEUE_URL  = module.queues.queue_urls["conversation-turns"]
        SQS_INGEST_QUEUE_URL = module.queues.queue_urls["ingest"]
        AUDIT_ANCHOR_BUCKET  = module.storage.bucket_names["audit-anchors"]
        PUBLIC_APP_URL       = local.public_url
      }
    }[each.key] : k => v },
  )

  secrets = {
    api = {
      DASHBOARD_DATABASE_URL = local.secret["dashboard-database-url"]
      VISITOR_DATABASE_URL   = local.secret["visitor-database-url"]
      VISITOR_TOKEN_SECRET   = local.secret["visitor-token-secret"]
      SESSION_SECRET         = local.secret["session-secret"]
      IDENTITY_DATABASE_URL  = local.secret["identity-database-url"]
      MAGIC_LINK_SECRET      = local.secret["magic-link-secret"]
      SMTP_URL               = local.secret["smtp-url"]
      MFA_SECRET_KEY         = local.secret["mfa-secret-key"]
    }
    realtime = {
      DASHBOARD_DATABASE_URL = local.secret["dashboard-database-url"]
      VISITOR_DATABASE_URL   = local.secret["visitor-database-url"]
      IDENTITY_DATABASE_URL  = local.secret["identity-database-url"]
      VISITOR_TOKEN_SECRET   = local.secret["visitor-token-secret"]
    }
    agent-worker  = { VISITOR_DATABASE_URL = local.secret["visitor-database-url"] }
    ingest-worker = { INGEST_DATABASE_URL = local.secret["ingest-database-url"] }
    scheduler-worker = {
      OUTBOX_DATABASE_URL   = local.secret["outbox-database-url"]
      IDENTITY_DATABASE_URL = local.secret["identity-database-url"]
      MAGIC_LINK_SECRET     = local.secret["magic-link-secret"]
      SMTP_URL              = local.secret["smtp-url"]
    }
  }[each.key]
}

module "ci" {
  source                      = "../../modules/ci-oidc"
  name                        = var.name
  github_repository           = var.github_repository
  github_environment          = "prod"
  ecr_repository_arns         = module.cluster.repository_arns
  static_bucket_arn           = module.storage.bucket_arns["static"]
  cloudfront_distribution_arn = module.edge.distribution_arn
}
