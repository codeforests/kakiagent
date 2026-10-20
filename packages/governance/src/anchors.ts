import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { sql, type ZoneDb } from '@kaki/db';
import type { Anchor, AnchorSource } from './verify.js';

/** Where chain heads are anchored: an S3 bucket with Object Lock (ADR-014 decision 5). */
export interface AnchorStore extends AnchorSource {
  put(anchor: { tenantId: string; seq: number; hash: string; anchoredAt: string }): Promise<void>;
}

const SEQ_DIGITS = 20;
const KEY_RE = /\/(\d{20})-([0-9a-f]{64})\.json$/;

/** `audit/<tenant>/<seq>-<hash>.json`: a listing alone yields every anchor. */
export const anchorKey = (tenantId: string, seq: number, hash: string) =>
  `audit/${tenantId}/${String(seq).padStart(SEQ_DIGITS, '0')}-${hash}.json`;

/**
 * S3 anchors. The bucket's default compliance-mode retention locks every object, so
 * neither the application nor the root account can shorten it (OI-5). LocalStack
 * locally, through `endpoint`.
 */
export function createS3AnchorStore(cfg: {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
}): AnchorStore & { s3: S3Client } {
  const s3 = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
  });
  return {
    s3,
    async put(a) {
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: anchorKey(a.tenantId, a.seq, a.hash),
          Body: JSON.stringify(a),
          ContentType: 'application/json',
          // Object Lock requires an integrity checksum on every put.
          ChecksumAlgorithm: 'SHA256',
        }),
      );
    },
    async list(tenantId) {
      const out: Anchor[] = [];
      let token: string | undefined;
      do {
        const page: ListObjectsV2CommandOutput = await s3.send(
          new ListObjectsV2Command({
            Bucket: cfg.bucket,
            Prefix: `audit/${tenantId}/`,
            ContinuationToken: token,
          }),
        );
        for (const o of page.Contents ?? []) {
          const m = o.Key ? KEY_RE.exec(o.Key) : null;
          if (m) out.push({ seq: Number(m[1]), hash: m[2]! });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out.sort((x, y) => x.seq - y.seq);
    },
  };
}

interface HeadRow extends Record<string, unknown> {
  tenant_id: string;
  seq: string | number;
  hash: string;
}

/**
 * The scheduler's anchor job (outbox trust zone): anchors every head that moved since
 * its last anchor, then records it. A crash in between re-anchors the same head on the
 * next run, under the same key: harmless (design D9).
 */
export async function anchorHeads(
  zdb: ZoneDb,
  store: AnchorStore,
  now: () => Date = () => new Date(),
): Promise<{ anchored: number }> {
  const { rows } = await zdb.db.execute<HeadRow>(
    sql`select tenant_id, seq, hash from audit_heads_to_anchor()`,
  );
  for (const h of rows) {
    const seq = Number(h.seq);
    await store.put({ tenantId: h.tenant_id, seq, hash: h.hash, anchoredAt: now().toISOString() });
    await zdb.db.execute(sql`select audit_mark_anchored(${h.tenant_id}::uuid, ${seq}::bigint)`);
  }
  return { anchored: rows.length };
}
