#!/usr/bin/env bash
# Runs a command with the integration-test environment, for sessions without Docker.
#   scripts/test-env.sh pnpm --filter @kaki/kb test:integration
# With Docker this just runs the command (Testcontainers starts Postgres itself).
# Without Docker it starts the local Postgres 16 cluster, installs pgvector if it is
# missing, lets local TCP connections in without a password, and exports
# KAKI_TEST_DATABASE_URL. Cloud containers only; never run it on a shared server.
set -euo pipefail

if timeout 10 docker info >/dev/null 2>&1; then
  exec "$@"
fi

if [ ! -f /usr/share/postgresql/16/extension/vector.control ]; then
  (apt-get install -y -q postgresql-16-pgvector || { apt-get update -q && apt-get install -y -q postgresql-16-pgvector; }) >/dev/null
fi

hba=/etc/postgresql/16/main/pg_hba.conf
if ! grep -q '^host all all 127.0.0.1/32 trust' "$hba"; then
  sed -i '1i host all all 127.0.0.1/32 trust\nhost all all ::1/128 trust' "$hba"
  pg_ctlcluster 16 main status >/dev/null 2>&1 && pg_ctlcluster 16 main reload
fi
pg_ctlcluster 16 main status >/dev/null 2>&1 || pg_ctlcluster 16 main start

export KAKI_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres
exec "$@"
