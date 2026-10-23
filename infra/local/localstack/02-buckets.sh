#!/bin/sh
# Creates the buckets in LocalStack, mirroring infra/terraform/modules/storage:
# - the audit anchor bucket (ADR-014 decision 5): Object Lock with a compliance-mode
#   default retention (1 day locally; production uses audit_anchor_retention_days);
# - quarantine (FEAT-015 §5.3): browsers PUT uploads to it through presigned URLs (CORS
#   for the dashboard), and anything left there is deleted after a day;
# - sources: the clean files the ingest worker copies out of quarantine.
set -eu
if ! awslocal s3api head-bucket --bucket kaki-local-audit-anchors >/dev/null 2>&1; then
  awslocal s3api create-bucket --bucket kaki-local-audit-anchors \
    --create-bucket-configuration LocationConstraint=ap-southeast-1 \
    --object-lock-enabled-for-bucket >/dev/null
  awslocal s3api put-object-lock-configuration --bucket kaki-local-audit-anchors \
    --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":1}}}'
fi
for bucket in kaki-local-quarantine kaki-local-sources; do
  if ! awslocal s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    awslocal s3api create-bucket --bucket "$bucket" \
      --create-bucket-configuration LocationConstraint=ap-southeast-1 >/dev/null
  fi
done
awslocal s3api put-bucket-lifecycle-configuration --bucket kaki-local-quarantine \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-uploads","Status":"Enabled","Filter":{"Prefix":"uploads/"},"Expiration":{"Days":1}}]}'
awslocal s3api put-bucket-cors --bucket kaki-local-quarantine \
  --cors-configuration '{"CORSRules":[{"AllowedOrigins":["http://localhost:5173"],"AllowedMethods":["PUT"],"AllowedHeaders":["*"],"MaxAgeSeconds":3000}]}'
echo "localstack: buckets ready"
