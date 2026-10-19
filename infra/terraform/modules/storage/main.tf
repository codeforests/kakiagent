# S3 buckets (architecture §7). All private, KMS-encrypted, versioned, in-region only
# (no replication, NFR-07). audit-anchors uses Object Lock (ADR-014). `static` holds
# the widget, dashboard and operator builds, served only through CloudFront.

locals {
  buckets = toset(["quarantine", "sources", "attachments", "exports", "audit-anchors", "static"])
}

resource "aws_s3_bucket" "this" {
  for_each            = local.buckets
  bucket              = "${var.name}-${each.key}"
  object_lock_enabled = each.key == "audit-anchors"
  force_destroy       = var.force_destroy && each.key != "audit-anchors"
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

# The static bucket uses S3-managed keys so CloudFront can read it through OAC
# without a KMS grant; it holds only public build output.
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = each.key == "static" ? "AES256" : "aws:kms"
      kms_master_key_id = each.key == "static" ? null : var.kms_key_arn
    }
    bucket_key_enabled = each.key != "static"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit_anchors" {
  bucket = aws_s3_bucket.this["audit-anchors"].id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.audit_anchor_retention_days
    }
  }
}

# Uploads land in quarantine until the malware check passes (ADR-018); unclaimed
# objects expire.
resource "aws_s3_bucket_lifecycle_configuration" "quarantine" {
  bucket = aws_s3_bucket.this["quarantine"].id
  rule {
    id     = "expire-unscanned"
    status = "Enabled"
    filter {}
    expiration {
      days = 7
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}
