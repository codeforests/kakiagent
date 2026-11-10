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
    "channel-secret-key", # seals channel credentials (FEAT-037 §5.2) until the KMS sealer at MD
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
    resources = [module.queues.queue_arns["conversation-turns"], module.queues.queue_arns["channel-send"], module.mail.inbound.queue_arn]
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

# The email channel (FEAT-036 §5.6). The api and the scheduler manage tenants' own sending
# domains (create, check, remove; D1); new identities join the configuration set so their
# bounces reach the inbound topic.
data "aws_iam_policy_document" "email_identities" {
  statement {
    actions = [
      "ses:CreateEmailIdentity", "ses:GetEmailIdentity", "ses:DeleteEmailIdentity",
      "ses:PutEmailIdentityMailFromAttributes",
    ]
    resources = [
      "arn:aws:ses:${local.region}:${data.aws_caller_identity.current.account_id}:identity/*",
      module.mail.configuration_set_arn,
    ]
  }
}

# The api signs attachment downloads (presigned GETs, FEAT-036 §5.5).
data "aws_iam_policy_document" "attachment_reader" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${module.storage.bucket_arns["attachments"]}/email/*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [module.data.kms_key_arn]
  }
}

# The agent-worker reads and deletes raw mail, and puts attachments into quarantine for the
# scan (FEAT-036 §5.2). ListBucket lets a missing raw object read as 404, not 403.
data "aws_iam_policy_document" "mail_receiver" {
  statement {
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${module.mail.inbound.bucket_arn}/${module.mail.inbound.object_prefix}*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [module.mail.inbound.bucket_arn]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${module.storage.bucket_arns["quarantine"]}/email/*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [module.mail.inbound.kms_key_arn]
  }
  statement {
    actions   = ["kms:GenerateDataKey"]
    resources = [module.data.kms_key_arn]
  }
}

# The ingest worker scans quarantined attachments and copies clean ones to the attachments
# bucket under the same key (FEAT-036 §5.2 step 4).
data "aws_iam_policy_document" "attachment_scanner" {
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectTagging", "s3:DeleteObject"]
    resources = ["${module.storage.bucket_arns["quarantine"]}/email/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${module.storage.bucket_arns["attachments"]}/email/*"]
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
    api = {
      uploads     = data.aws_iam_policy_document.upload_signer.json
      identities  = data.aws_iam_policy_document.email_identities.json
      attachments = data.aws_iam_policy_document.attachment_reader.json
    }
    agent-worker = {
      sqs  = data.aws_iam_policy_document.turns_consumer.json
      mail = data.aws_iam_policy_document.mail_receiver.json
    }
    ingest-worker = {
      sqs         = data.aws_iam_policy_document.ingest_consumer.json
      files       = data.aws_iam_policy_document.file_store.json
      attachments = data.aws_iam_policy_document.attachment_scanner.json
    }
    scheduler-worker = {
      sqs        = data.aws_iam_policy_document.turns_producer.json
      audit      = data.aws_iam_policy_document.audit_anchor_writer.json
      identities = data.aws_iam_policy_document.email_identities.json
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
        EMAIL_FROM                = "KakiAgent <${module.mail.from_address}>"
        EMAIL_INBOUND_DOMAIN      = module.mail.inbound.domain
        ATTACHMENTS_BUCKET        = module.storage.bucket_names["attachments"]
        EMAIL_IDENTITY_PROVIDER   = "ses"
        SES_CONFIGURATION_SET     = module.mail.configuration_set_name
        # The Telegram channel (FEAT-037 §5.6): webhooks arrive at /hooks/telegram/<id>.
        PUBLIC_HOOKS_URL = local.public_url
      }
      realtime = { PORT = "3001", VALKEY_URL = local.valkey }
      agent-worker = {
        HEALTH_PORT         = "3002"
        AWS_REGION          = local.region
        SQS_TURNS_QUEUE_URL = module.queues.queue_urls["conversation-turns"]
        VALKEY_URL          = local.valkey
        LLM_PROVIDER        = "fake" # the Bedrock au. provider arrives at MD (ADR-006)
        # The email channel (FEAT-036 §5.2, §5.3).
        EMAIL_INBOUND_DOMAIN        = module.mail.inbound.domain
        EMAIL_INBOUND_BUCKET        = module.mail.inbound.bucket_name
        EMAIL_SNS_TOPIC_ARN         = module.mail.inbound.topic_arn
        SQS_EMAIL_INBOUND_QUEUE_URL = module.mail.inbound.queue_url
        QUARANTINE_BUCKET           = module.storage.bucket_names["quarantine"]
        SQS_CHANNEL_SEND_QUEUE_URL  = module.queues.queue_urls["channel-send"]
        EMAIL_FROM                  = "KakiAgent <${module.mail.from_address}>"
        SES_MESSAGE_ID_DOMAIN       = module.mail.message_id_domain
      }
      ingest-worker = {
        HEALTH_PORT          = "3003"
        AWS_REGION           = local.region
        SQS_INGEST_QUEUE_URL = module.queues.queue_urls["ingest"]
        WIDGET_ASSET_URL     = "${local.public_url}/w/v1/" # detect.js (FEAT-032 D4)
        LLM_PROVIDER         = "fake"                      # the Bedrock au. provider arrives at MD (ADR-006)
        QUARANTINE_BUCKET    = module.storage.bucket_names["quarantine"]
        SOURCES_BUCKET       = module.storage.bucket_names["sources"]
        ATTACHMENTS_BUCKET   = module.storage.bucket_names["attachments"]
        MALWARE_SCANNER      = "guardduty" # FEAT-015 §5.3; ClamAV is the local stand-in
      }
      scheduler-worker = {
        HEALTH_PORT          = "3004"
        AWS_REGION           = local.region
        SQS_TURNS_QUEUE_URL  = module.queues.queue_urls["conversation-turns"]
        SQS_INGEST_QUEUE_URL = module.queues.queue_urls["ingest"]
        AUDIT_ANCHOR_BUCKET  = module.storage.bucket_names["audit-anchors"]
        PUBLIC_APP_URL       = local.public_url
        EMAIL_FROM           = "KakiAgent <${module.mail.from_address}>"
        # FEAT-036: the delivery sweep re-enqueues due sends; domain checks use SES.
        SQS_CHANNEL_SEND_QUEUE_URL = module.queues.queue_urls["channel-send"]
        EMAIL_IDENTITY_PROVIDER    = "ses"
        SES_CONFIGURATION_SET      = module.mail.configuration_set_name
        # FEAT-037: Telegram's health check re-registers a missing webhook here.
        PUBLIC_HOOKS_URL = local.public_url
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
      CHANNEL_SECRET_KEY     = local.secret["channel-secret-key"]
    }
    realtime = {
      DASHBOARD_DATABASE_URL = local.secret["dashboard-database-url"]
      VISITOR_DATABASE_URL   = local.secret["visitor-database-url"]
      IDENTITY_DATABASE_URL  = local.secret["identity-database-url"]
      VISITOR_TOKEN_SECRET   = local.secret["visitor-token-secret"]
    }
    agent-worker = {
      VISITOR_DATABASE_URL = local.secret["visitor-database-url"]
      SMTP_URL             = local.secret["smtp-url"]           # email channel replies (FEAT-036 §5.3)
      CHANNEL_SECRET_KEY   = local.secret["channel-secret-key"] # Telegram sends (FEAT-037)
    }
    ingest-worker = { INGEST_DATABASE_URL = local.secret["ingest-database-url"] }
    scheduler-worker = {
      OUTBOX_DATABASE_URL   = local.secret["outbox-database-url"]
      IDENTITY_DATABASE_URL = local.secret["identity-database-url"]
      MAGIC_LINK_SECRET     = local.secret["magic-link-secret"]
      SMTP_URL              = local.secret["smtp-url"]
      # Telegram alerts and health (FEAT-037 §5.5, D9): links and the bot credential.
      VISITOR_DATABASE_URL = local.secret["visitor-database-url"]
      CHANNEL_SECRET_KEY   = local.secret["channel-secret-key"]
    }
  }[each.key]
}

# Email authentication (NFR-18; FEAT-052 §5.6): DKIM, MAIL FROM (SPF), DMARC and the
# bounce-rate alarm. The api and scheduler send as no-reply@<mail_domain>. The email
# channel (FEAT-036) receives at in.<mail_domain> and replies from it.
module "mail" {
  source               = "../../modules/mail"
  name                 = var.name
  mail_domain          = var.mail_domain
  dmarc_report_address = var.dmarc_report_address
  region               = local.region
  inbound_bucket_name  = "${local.bucket_pfx}-inbound-mail"
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
