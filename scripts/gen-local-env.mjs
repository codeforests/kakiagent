#!/usr/bin/env node
// Generates the gitignored local config files from each unit's .env.example:
// derivable values (compose URLs, ports) are filled in; local secrets and database
// passwords are random, generated once and reused on later runs. Nothing here needs a
// third-party key: the fake LLM provider is the default.
//   node scripts/gen-local-env.mjs           create missing .env files
//   node scripts/gen-local-env.mjs --force   regenerate them all (new passwords: run pnpm stack:reset)
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const force = process.argv.includes('--force');
const rand = () => randomBytes(24).toString('base64url');
const read = (f) =>
  existsSync(f)
    ? Object.fromEntries(
        readFileSync(f, 'utf8')
          .split('\n')
          .filter((l) => /^[A-Z_]+=/.test(l))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      )
    : {};

// Reuse existing secrets so regenerating one unit never desynchronises another.
const prev = force ? {} : read('.env');
const s = {
  POSTGRES_PASSWORD: prev.POSTGRES_PASSWORD ?? rand(),
  APP_DASHBOARD_PASSWORD: prev.APP_DASHBOARD_PASSWORD ?? rand(),
  APP_AGENT_VISITOR_PASSWORD: prev.APP_AGENT_VISITOR_PASSWORD ?? rand(),
  APP_OUTBOX_PASSWORD: prev.APP_OUTBOX_PASSWORD ?? rand(),
  APP_IDENTITY_PASSWORD: prev.APP_IDENTITY_PASSWORD ?? rand(),
  APP_INGEST_PASSWORD: prev.APP_INGEST_PASSWORD ?? rand(),
  VISITOR_TOKEN_SECRET: prev.VISITOR_TOKEN_SECRET ?? rand() + rand(),
  SESSION_SECRET: prev.SESSION_SECRET ?? rand() + rand(),
  MAGIC_LINK_SECRET: prev.MAGIC_LINK_SECRET ?? rand() + rand(),
};
const pg = (user, pw) => `postgres://${user}:${pw}@localhost:5432/kakiagent`;
const mail = {
  SMTP_URL: 'smtp://localhost:1025',
  PUBLIC_APP_URL: 'http://localhost:5173',
  MAGIC_LINK_SECRET: s.MAGIC_LINK_SECRET,
};
const queue =
  'http://sqs.ap-southeast-1.localhost.localstack.cloud:4566/000000000000/conversation-turns.fifo';
const ingestQueue =
  'http://sqs.ap-southeast-1.localhost.localstack.cloud:4566/000000000000/ingest.fifo';

const files = {
  // Root .env: read by docker compose, and the source of truth for local secrets.
  '.env': { ...s },
  'packages/db/.env': {
    DATABASE_OWNER_URL: pg('kaki_owner', s.POSTGRES_PASSWORD),
    SEED_DEV_TENANTS: 'true',
    WIDGET_DEV_ORIGINS: 'http://localhost:5175',
    APP_DASHBOARD_PASSWORD: s.APP_DASHBOARD_PASSWORD,
    APP_AGENT_VISITOR_PASSWORD: s.APP_AGENT_VISITOR_PASSWORD,
    APP_OUTBOX_PASSWORD: s.APP_OUTBOX_PASSWORD,
    APP_IDENTITY_PASSWORD: s.APP_IDENTITY_PASSWORD,
    APP_INGEST_PASSWORD: s.APP_INGEST_PASSWORD,
  },
  'apps/api/.env': {
    // Local HTTP: browsers drop a Secure cookie on http://localhost in some setups.
    COOKIE_SECURE: 'false',
    ...mail,
    IDENTITY_DATABASE_URL: pg('app_identity', s.APP_IDENTITY_PASSWORD),
    DASHBOARD_DATABASE_URL: pg('app_dashboard', s.APP_DASHBOARD_PASSWORD),
    VISITOR_DATABASE_URL: pg('app_agent_visitor', s.APP_AGENT_VISITOR_PASSWORD),
    VISITOR_TOKEN_SECRET: s.VISITOR_TOKEN_SECRET,
    SESSION_SECRET: s.SESSION_SECRET,
  },
  'apps/realtime/.env': {
    DASHBOARD_DATABASE_URL: pg('app_dashboard', s.APP_DASHBOARD_PASSWORD),
    VISITOR_DATABASE_URL: pg('app_agent_visitor', s.APP_AGENT_VISITOR_PASSWORD),
    IDENTITY_DATABASE_URL: pg('app_identity', s.APP_IDENTITY_PASSWORD),
    VISITOR_TOKEN_SECRET: s.VISITOR_TOKEN_SECRET,
  },
  'apps/agent-worker/.env': {
    VISITOR_DATABASE_URL: pg('app_agent_visitor', s.APP_AGENT_VISITOR_PASSWORD),
    SQS_TURNS_QUEUE_URL: queue,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  },
  'apps/scheduler-worker/.env': {
    OUTBOX_DATABASE_URL: pg('app_outbox', s.APP_OUTBOX_PASSWORD),
    IDENTITY_DATABASE_URL: pg('app_identity', s.APP_IDENTITY_PASSWORD),
    ...mail,
    SQS_TURNS_QUEUE_URL: queue,
    SQS_INGEST_QUEUE_URL: ingestQueue,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  },
  'packages/governance/.env': {
    DASHBOARD_DATABASE_URL: pg('app_dashboard', s.APP_DASHBOARD_PASSWORD),
  },
  'apps/ingest-worker/.env': {
    INGEST_DATABASE_URL: pg('app_ingest', s.APP_INGEST_PASSWORD),
    SQS_INGEST_QUEUE_URL: ingestQueue,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    // The local fixture site and dev pages run on 127.0.0.1 (FEAT-012 §5.6, dev-only).
    CRAWL_ALLOW_PRIVATE_HOSTS: 'true',
  },
  'apps/widget/.env': {},
  'apps/dashboard/.env': {},
  'apps/operator/.env': {},
};

for (const [file, overrides] of Object.entries(files)) {
  if (existsSync(file) && !force && file !== '.env') {
    // Keep the file, but add variables a newer feature introduced (e.g. app_ingest).
    const have = read(file);
    const missing = Object.entries(overrides).filter(([k]) => !(k in have));
    if (missing.length) {
      const text = readFileSync(file, 'utf8').replace(/\n*$/, '\n');
      writeFileSync(file, text + missing.map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
      console.log(`updated   ${file} (added ${missing.map(([k]) => k).join(', ')})`);
    } else console.log(`kept      ${file}`);
    continue;
  }
  const example =
    file === '.env' ? '' : readFileSync(file.replace(/\.env$/, '.env.example'), 'utf8');
  const lines = example
    .split('\n')
    .filter((l) => !/^[A-Z_]+=/.test(l) || !(l.slice(0, l.indexOf('=')) in overrides))
    .map((l) => l);
  const out = [
    '# GENERATED by scripts/gen-local-env.mjs for local development. Not committed.',
    ...lines.filter((l) => !l.startsWith('# ') || !l.includes('generated into .env')),
    ...Object.entries(overrides).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');
  writeFileSync(file, out.replace(/\n{3,}/g, '\n\n'));
  console.log(`wrote     ${file}`);
}
