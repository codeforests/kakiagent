/**
 * `pnpm audit:verify --tenant <uuid> [--from <seq>] [--to <seq>] [--no-anchors]`:
 * recomputes a tenant's audit chain and compares it with its S3 anchors (ADR-014
 * decision 6, GOV-01). Prints the result as JSON. Exit 0 intact, 1 broken, 2 on a usage
 * or connection error. Reads packages/governance/.env (scripts/gen-local-env.mjs).
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createZoneDb } from '@kaki/db';
import { createS3AnchorStore } from '../src/anchors.js';
import { verifyChain } from '../src/verify.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  console.error(`audit:verify: ${message}`);
  process.exit(2);
}

if (existsSync('.env')) process.loadEnvFile('.env');

let args;
try {
  args = parseArgs({
    options: {
      tenant: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'no-anchors': { type: 'boolean', default: false },
    },
  }).values;
} catch (err) {
  fail((err as Error).message);
}
const tenant = args.tenant;
if (!tenant || !UUID_RE.test(tenant)) fail('--tenant must be a tenant UUID');
const seqArg = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1) fail(`--${name} must be a positive integer`);
  return Number(v);
};
const fromSeq = seqArg(args.from, 'from');
const toSeq = seqArg(args.to, 'to');

const dbUrl = process.env.DASHBOARD_DATABASE_URL;
if (!dbUrl) fail('DASHBOARD_DATABASE_URL is not set (see packages/governance/.env.example)');
const bucket = process.env.AUDIT_ANCHOR_BUCKET;
if (!args['no-anchors'] && !bucket) fail('AUDIT_ANCHOR_BUCKET is not set; or pass --no-anchors');

const zdb = createZoneDb('dashboard', dbUrl, 2);
try {
  const result = await verifyChain(zdb, tenant, {
    anchors: args['no-anchors']
      ? undefined
      : createS3AnchorStore({
          bucket: bucket!,
          region: process.env.AWS_REGION ?? 'ap-southeast-1',
          endpoint: process.env.AWS_ENDPOINT_URL || undefined,
        }),
    ...(fromSeq ? { fromSeq } : {}),
    ...(toSeq ? { toSeq } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} catch (err) {
  fail((err as Error).message);
} finally {
  await zdb.pool.end();
}
