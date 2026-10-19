#!/bin/sh
# Creates the audit anchor bucket in LocalStack (ADR-014 decision 5), mirroring
# infra/terraform/modules/storage: Object Lock with a compliance-mode default
# retention (1 day locally; production uses audit_anchor_retention_days).
set -eu
if ! awslocal s3api head-bucket --bucket kaki-local-audit-anchors >/dev/null 2>&1; then
  awslocal s3api create-bucket --bucket kaki-local-audit-anchors \
    --create-bucket-configuration LocationConstraint=ap-southeast-1 \
    --object-lock-enabled-for-bucket >/dev/null
  awslocal s3api put-object-lock-configuration --bucket kaki-local-audit-anchors \
    --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":1}}}'
fi
echo "localstack: buckets ready"
