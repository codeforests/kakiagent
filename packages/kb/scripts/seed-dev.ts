/**
 * DEV-ONLY demonstration facts (FEAT-022 §5), run by `pnpm db:setup` after the dev
 * tenants exist. Both must never reach a bakery visitor: a `needs_review` bakery fact
 * and an approved fact of the second tenant (AC-7, AC-16). Fixed IDs keep it
 * idempotent. Reads packages/db/.env, like the db setup.
 */
import { createZoneDb, schema, withTenant } from '@kaki/db';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import { existsSync } from 'node:fs';
import { prepareChunk, type FactInput } from '../src/index.js';

const envFile = '../db/.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is not set (see packages/db/.env.example)');
if (process.env.SEED_DEV_TENANTS !== 'true') {
  console.log('kb dev facts skipped (SEED_DEV_TENANTS is not true)');
  process.exit(0);
}

const seeds: {
  tenantId: string;
  id: string;
  status: 'needs_review' | 'approved';
  input: FactInput;
}[] = [
  {
    tenantId: '11111111-1111-4111-8111-111111111111',
    id: 'dd000001-0000-4000-8000-000000000001',
    status: 'needs_review',
    input: {
      type: 'product',
      value: { name: 'Eggless chocolate cake', priceCents: 7000, currency: 'SGD', unit: '1 kg' },
      gstTreatment: 'inclusive',
    },
  },
  {
    tenantId: '22222222-2222-4222-8222-222222222222',
    id: 'dd000002-0000-4000-8000-000000000002',
    status: 'approved',
    input: {
      type: 'product',
      value: { name: 'Chocolate fudge cake', priceCents: 9900, currency: 'SGD', unit: '1 kg' },
      gstTreatment: 'inclusive',
    },
  },
];

// The fake embedder (D5): the same one the api uses locally.
const llm = gatewayFromConfig({ provider: 'fake' });
const zdb = createZoneDb('dashboard', ownerUrl, 1);
try {
  for (const s of seeds) {
    const chunk = await prepareChunk(llm, s.tenantId, s.input);
    await withTenant(zdb, s.tenantId, async (tx) => {
      const [row] = await tx
        .insert(schema.facts)
        .values({
          tenantId: s.tenantId,
          id: s.id,
          type: s.input.type,
          status: s.status,
          value: s.input.value,
          gstTreatment: s.input.gstTreatment,
          source: 'dev_seed',
          createdBy: 'dev-seed',
          updatedBy: 'dev-seed',
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return;
      await tx.insert(schema.factVersions).values({
        tenantId: s.tenantId,
        factId: s.id,
        version: 1,
        status: s.status,
        value: s.input.value,
        gstTreatment: s.input.gstTreatment,
        changedBy: 'dev-seed',
      });
      await tx.insert(schema.kbChunks).values({
        tenantId: s.tenantId,
        factId: s.id,
        factVersion: 1,
        content: chunk.content,
        embedding: chunk.embedding,
      });
    });
  }
  console.log('kb dev facts ready');
} finally {
  await zdb.pool.end();
}
