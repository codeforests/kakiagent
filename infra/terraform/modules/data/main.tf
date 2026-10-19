# The PostgreSQL system of record and ElastiCache Valkey in the isolated data subnets.
# The launch profile runs RDS PostgreSQL single AZ (ADR-024); the ADR-004 profile runs
# Aurora (writer + reader). Same engine, extensions, roles and migrations either way. Maintenance and backups fall inside
# 02:00–06:00 SGT, which is 18:00–22:00 UTC (NFR-04). Backups stay in-region (NFR-07).

resource "aws_kms_key" "data" {
  description         = "${var.name} data at rest"
  enable_key_rotation = true
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

locals {
  aurora = var.database_engine == "aurora" ? 1 : 0
  rds    = var.database_engine == "rds" ? 1 : 0
}

resource "aws_security_group" "aurora" {
  name        = "${var.name}-postgres"
  description = "PostgreSQL, reachable from the ECS tasks only"
  vpc_id      = var.vpc_id
  ingress {
    description     = "PostgreSQL from the app tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
}

resource "aws_security_group" "valkey" {
  name        = "${var.name}-valkey"
  description = "Valkey, reachable from the ECS tasks only"
  vpc_id      = var.vpc_id
  ingress {
    description     = "Valkey from the app tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.data_subnet_ids
}

resource "aws_rds_cluster" "this" {
  count                               = local.aurora
  cluster_identifier                  = var.name
  engine                              = "aurora-postgresql"
  engine_mode                         = "provisioned"
  engine_version                      = var.aurora_engine_version
  database_name                       = "kakiagent"
  master_username                     = "kaki_owner"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = aws_kms_key.data.arn
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.aurora.id]
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.data.arn
  backup_retention_period             = 35
  preferred_backup_window             = "18:00-18:30"
  preferred_maintenance_window        = "sat:19:00-sat:21:00"
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = !var.deletion_protection
  final_snapshot_identifier           = var.deletion_protection ? "${var.name}-final" : null
  copy_tags_to_snapshot               = true
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }
}

resource "aws_rds_cluster_instance" "this" {
  count                           = local.aurora * var.aurora_instance_count
  identifier                      = "${var.name}-${count.index}"
  cluster_identifier              = aws_rds_cluster.this[0].id
  engine                          = aws_rds_cluster.this[0].engine
  engine_version                  = aws_rds_cluster.this[0].engine_version
  instance_class                  = "db.serverless"
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
}

resource "aws_db_parameter_group" "rds" {
  count  = local.rds
  name   = "${var.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "this" {
  count                               = local.rds
  identifier                          = var.name
  engine                              = "postgres"
  engine_version                      = var.rds_engine_version
  instance_class                      = var.rds_instance_class
  allocated_storage                   = var.rds_allocated_storage_gb
  max_allocated_storage               = var.rds_max_allocated_storage_gb
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.data.arn
  db_name                             = "kakiagent"
  username                            = "kaki_owner"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = aws_kms_key.data.arn
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.aurora.id]
  parameter_group_name                = aws_db_parameter_group.rds[0].name
  multi_az                            = false
  publicly_accessible                 = false
  backup_retention_period             = 35
  backup_window                       = "18:00-18:30"
  maintenance_window                  = "sat:19:00-sat:21:00"
  auto_minor_version_upgrade          = true
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = !var.deletion_protection
  final_snapshot_identifier           = var.deletion_protection ? "${var.name}-final" : null
  iam_database_authentication_enabled = true
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.data.arn
  enabled_cloudwatch_logs_exports     = ["postgresql"]
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.data_subnet_ids
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = var.name
  description                = "${var.name} pub/sub, rate limits and caches"
  engine                     = "valkey"
  engine_version             = "8.0"
  node_type                  = var.valkey_node_type
  num_cache_clusters         = var.valkey_replicas + 1
  automatic_failover_enabled = var.valkey_replicas > 0
  multi_az_enabled           = var.valkey_replicas > 0
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.valkey.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  maintenance_window         = "sat:21:00-sat:22:00"
  snapshot_retention_limit   = 0
}
